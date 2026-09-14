import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { registerCaptureOcrReviewTool } from "../../src/tools/capture-ocr-review.js";
import { registerGenerateGapReportTool } from "../../src/tools/generate-gap-report.js";
import { registerProbeApplicationTool } from "../../src/tools/probe-application.js";
import { registerSynthesizeMissingContentTool } from "../../src/tools/synthesize-missing-content.js";

const testContext = vi.hoisted(() => ({
  store: null as StateStore | null,
  notion: null as ReturnType<typeof createFakeNotion> | null,
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => {
    if (!testContext.notion) throw new Error("Fake Notion not initialized");
    return testContext.notion;
  },
}));

vi.mock("../../src/lib/state-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/state-store.js")>("../../src/lib/state-store.js");
  return {
    ...actual,
    getStateStore: () => {
      if (!testContext.store) throw new Error("State store not initialized");
      return testContext.store;
    },
  };
});

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();
  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

type FakePage = {
  id: string;
  parent: { database_id: string };
  properties: Record<string, unknown>;
  children: unknown[];
  url?: string;
};

function titleText(property: unknown): string {
  return (property as { title?: Array<{ text?: { content?: string } }> } | undefined)?.title?.[0]?.text?.content ?? "";
}

function relationIds(property: unknown): string[] {
  return ((property as { relation?: Array<{ id?: string }> } | undefined)?.relation ?? [])
    .map((item) => item.id)
    .filter((id): id is string => Boolean(id));
}

function createFakeNotion() {
  let counter = 0;
  const pages = new Map<string, FakePage>();
  function nextId() {
    counter += 1;
    return `page_${counter}`;
  }
  function matches(page: FakePage, filter: Record<string, unknown>): boolean {
    if (Array.isArray(filter.and)) {
      return filter.and.every((item) => matches(page, item as Record<string, unknown>));
    }
    const propertyName = filter.property;
    if (typeof propertyName !== "string") return true;
    const property = page.properties[propertyName];
    if (filter.title && typeof filter.title === "object") {
      return titleText(property) === (filter.title as { equals?: string }).equals;
    }
    if (filter.rich_text && typeof filter.rich_text === "object") {
      return false;
    }
    if (filter.relation && typeof filter.relation === "object") {
      const expected = (filter.relation as { contains?: string }).contains;
      return typeof expected !== "string" || relationIds(property).includes(expected);
    }
    return true;
  }

  return {
    _pages: pages,
    users: { me: vi.fn(async () => ({ id: "user_1" })) },
    databases: {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({ id: database_id })),
      query: vi.fn(async (input: { database_id: string; filter?: Record<string, unknown>; page_size?: number }) => {
        const results = Array.from(pages.values()).filter((page) => page.parent.database_id === input.database_id && (!input.filter || matches(page, input.filter)));
        return { results: results.slice(0, input.page_size ?? results.length), has_more: false, next_cursor: null };
      }),
    },
    pages: {
      create: vi.fn(async (input: { parent: { database_id: string }; properties: Record<string, unknown>; children?: unknown[] }) => {
        const id = nextId();
        const page = { id, parent: input.parent, properties: input.properties, children: input.children ?? [], url: `https://notion.local/${id}` };
        pages.set(id, page);
        return { id, url: page.url };
      }),
      update: vi.fn(async (input: { page_id: string; properties: Record<string, unknown> }) => {
        const page = pages.get(input.page_id);
        if (!page) throw new Error(`Missing page ${input.page_id}`);
        page.properties = { ...page.properties, ...input.properties };
        return { id: page.id, url: page.url };
      }),
    },
    blocks: { children: { list: vi.fn(async () => ({ results: [] })) } },
  };
}

function parseTool<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T;
}

async function createRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-probe-repo-"));
  await mkdir(join(repoPath, "src", "routes"), { recursive: true });
  await mkdir(join(repoPath, "src", "components"), { recursive: true });
  await writeFile(
    join(repoPath, "package.json"),
    JSON.stringify({ scripts: { start: "node server.js", test: "vitest run" } }, null, 2),
  );
  await writeFile(
    join(repoPath, "src", "routes", "billing.ts"),
    "export function billingWorkflow() {}\nrouter.post('/api/billing/export', handler)\nconst bucket = process.env.BILLING_EXPORT_BUCKET;\n",
  );
  await writeFile(join(repoPath, "src", "components", "BillingPanel.tsx"), "export function BillingPanel() { return <div />; }\n");
  return repoPath;
}

async function seedProject(statePath: string): Promise<StateStore> {
  const store = new StateStore(statePath);
  await store.upsertProject({
    projectId: "project_1",
    projectName: "Probe App",
    parentPageId: "parent_1",
    publishingMode: "Balanced",
    autoPublishThreshold: 60,
    projectPageId: "project_page_1",
    databases: {
      projectsDatabaseId: "projects_db",
      featuresDatabaseId: "features_db",
      manualEntriesDatabaseId: "manual_entries_db",
      evidenceEventsDatabaseId: "events_db",
      releasesDatabaseId: "releases_db",
    },
    featuresByKey: { "probe:package_script:start": "existing_feature_page" },
    eventsByExternalId: {},
    eventSnapshots: {},
  });
  return store;
}

afterEach(() => {
  delete process.env.AUTO_DOC_ALLOWED_REPO_ROOTS;
  delete process.env.AUTO_DOC_STATE_FILE;
  delete process.env.NOTION_TOKEN;
  delete process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;
  testContext.store = null;
  testContext.notion = null;
});

describe("retrospective probing system", () => {
  it("probes an existing repo, reports undocumented gaps, synthesizes Notion entries, and captures OCR evidence", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-probe-state-"));
    const repoPath = await createRepo();
    process.env.AUTO_DOC_ALLOWED_REPO_ROOTS = repoPath;
    process.env.AUTO_DOC_STATE_FILE = join(stateDir, "state.json");
    process.env.NOTION_TOKEN = "test-token";
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "false";
    testContext.store = await seedProject(process.env.AUTO_DOC_STATE_FILE);
    testContext.notion = createFakeNotion();

    const server = new FakeServer();
    registerProbeApplicationTool(server as unknown as McpServer);
    registerGenerateGapReportTool(server as unknown as McpServer);
    registerSynthesizeMissingContentTool(server as unknown as McpServer);
    registerCaptureOcrReviewTool(server as unknown as McpServer);

    const inventoryResult = parseTool<{ inventory: { features: Array<{ featureKey: string; apiEndpoints: string[]; envVars: string[] }> } }>(
      await server.handlers.get("probe_application")!({ repoPath }),
    );
    expect(inventoryResult.inventory.features.map((feature) => feature.featureKey)).toContain("probe:api_endpoint:post-api-billing-export");
    expect(inventoryResult.inventory.features.some((feature) => feature.envVars.includes("BILLING_EXPORT_BUCKET"))).toBe(true);

    const gapResult = parseTool<{ gapReport: { missingCount: number; gaps: Array<{ featureKey: string; status: string }> } }>(
      await server.handlers.get("generate_gap_report")!({ projectId: "project_1", inventory: inventoryResult.inventory }),
    );
    expect(gapResult.gapReport.gaps.find((gap) => gap.featureKey === "probe:package_script:start")?.status).toBe("documented");
    expect(gapResult.gapReport.missingCount).toBeGreaterThan(0);

    const synthesizeResult = parseTool<{ synthesizedCount: number; results: Array<{ featureKey: string; manualEntryCount: number }> }>(
      await server.handlers.get("synthesize_missing_content")!({
        projectId: "project_1",
        repoPath,
        gapReport: gapResult.gapReport,
        maxFeatures: 1,
      }),
    );
    expect(synthesizeResult.synthesizedCount).toBe(1);
    expect(synthesizeResult.results[0].manualEntryCount).toBeGreaterThan(0);

    const ocrResult = parseTool<{ evidenceEventId: string; findingCount: number; filesChanged: string[] }>(
      await server.handlers.get("capture_ocr_review")!({
        projectId: "project_1",
        reviewId: "review_1",
        summary: "Billing export security review",
        findings: [
          {
            file: "src/routes/billing.ts",
            line: 2,
            severity: "high",
            title: "Document billing export permission change",
            description: "The endpoint adds a permission-sensitive export path.",
          },
        ],
      }),
    );
    expect(ocrResult.evidenceEventId).toBe("ocr:review_1");
    expect(ocrResult.findingCount).toBe(1);
    expect(ocrResult.filesChanged).toEqual(["src/routes/billing.ts"]);

    const pages = Array.from(testContext.notion._pages.values());
    expect(pages.filter((page) => page.parent.database_id === "manual_entries_db").length).toBeGreaterThan(0);
    expect(pages.filter((page) => page.parent.database_id === "events_db").length).toBeGreaterThanOrEqual(2);
  });
});

