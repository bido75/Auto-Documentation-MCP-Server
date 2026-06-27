import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { registerAnalyzeDocumentationCandidateTool } from "../../src/tools/analyze-documentation-candidate.js";
import { registerRunAutonomousDocumentationTriggerTool } from "../../src/tools/run-autonomous-documentation-trigger.js";

const testContext = vi.hoisted(() => ({
  notion: null as ReturnType<typeof createFakeNotion> | null,
  store: null as StateStore | null,
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => {
    if (!testContext.notion) throw new Error("Fake Notion not initialized");
    return testContext.notion;
  },
}));

vi.mock("../../src/providers/factory.js", () => ({
  analyzeWithFallback: vi.fn(async () => ({
    featureName: "Provider Authored Billing Export",
    featureKey: "provider:authored-billing-export",
    shouldDocument: true,
    audiences: ["User", "Admin"],
    userGuide: {
      summary: "PROVIDER USER NARRATIVE: Billing users export invoices from Settings without asking support.",
      steps: ["Open Settings > Billing.", "Choose Export invoices.", "Download the generated CSV."],
      expectedOutcome: "PROVIDER USER OUTCOME: the CSV is downloaded and matches the visible billing period.",
      possibleErrors: ["PROVIDER USER TROUBLESHOOTING: ask an admin for Billing Reader access if Export is hidden."],
    },
    adminGuide: {
      configRequired: ["Set BILLING_EXPORT_BUCKET before enabling exports."],
      endpointsAffected: ["POST /api/billing/export"],
      envVarsRequired: ["BILLING_EXPORT_BUCKET"],
      verificationSteps: ["PROVIDER ADMIN VERIFY: run the export smoke test and confirm the object lands in storage."],
      troubleshooting: ["PROVIDER ADMIN TROUBLESHOOTING: rotate the storage credential if uploads fail with 403."],
    },
    developerNotes: "PROVIDER DEV NOTES: the export job streams rows and redacts account tokens.",
    confidenceScore: 91,
    confidenceReasons: ["Provider generated full manual prose."],
    reviewQuestions: [],
    providerUsed: "test-provider",
    generationMs: 5,
  })),
  embedText: vi.fn(async () => [1, 0, 0]),
}));

vi.mock("../../src/lib/state-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/state-store.js")>("../../src/lib/state-store.js");
  return {
    ...actual,
    getStateStore: () => {
      if (!testContext.store) throw new Error("Test store not initialized");
      return testContext.store;
    },
  };
});

type FakePage = {
  id: string;
  parent: { database_id: string };
  properties: Record<string, unknown>;
  children: unknown[];
};

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) {
    this.handlers.set(name, handler);
  }
}

function titleText(property: unknown): string {
  return (property as { title?: Array<{ text?: { content?: string } }> } | undefined)?.title?.[0]?.text?.content ?? "";
}

function richText(property: unknown): string {
  return (property as { rich_text?: Array<{ text?: { content?: string } }> } | undefined)?.rich_text?.[0]?.text?.content ?? "";
}

function relationIds(property: unknown): string[] {
  const relation = (property as { relation?: Array<{ id?: string }> } | undefined)?.relation ?? [];
  return relation.map((item) => item.id).filter((id): id is string => Boolean(id));
}

function createFakeNotion() {
  let counter = 0;
  const pages = new Map<string, FakePage>();

  function nextId(prefix: string) {
    counter += 1;
    return `${prefix}_${counter}`;
  }

  function matches(page: FakePage, clause: Record<string, unknown>) {
    const propertyName = clause.property;
    if (typeof propertyName !== "string") return false;
    const property = page.properties[propertyName];
    if (clause.rich_text && typeof clause.rich_text === "object") {
      return richText(property) === (clause.rich_text as { equals?: string }).equals;
    }
    if (clause.relation && typeof clause.relation === "object") {
      return relationIds(property).includes((clause.relation as { contains?: string }).contains ?? "");
    }
    if (clause.title && typeof clause.title === "object") {
      return titleText(property) === (clause.title as { equals?: string }).equals;
    }
    return false;
  }

  return {
    users: { me: vi.fn(async () => ({ id: "user_1" })) },
    databases: {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({ id: database_id })),
      query: vi.fn(async (input: { database_id: string; filter?: Record<string, unknown>; page_size?: number }) => {
        const results = Array.from(pages.values()).filter((page) => {
          if (page.parent.database_id !== input.database_id) return false;
          if (!input.filter) return true;
          if (Array.isArray(input.filter.and)) {
            return (input.filter.and as Array<Record<string, unknown>>).every((clause) => matches(page, clause));
          }
          return matches(page, input.filter);
        });
        return { results: results.slice(0, input.page_size ?? results.length).map((page) => ({ id: page.id, properties: page.properties })) };
      }),
    },
    pages: {
      create: vi.fn(async (input: { parent: { database_id: string }; properties: Record<string, unknown>; children?: unknown[] }) => {
        const page: FakePage = {
          id: nextId("page"),
          parent: input.parent,
          properties: { ...input.properties },
          children: input.children ?? [],
        };
        pages.set(page.id, page);
        return { id: page.id, url: `https://notion.local/${page.id}` };
      }),
      update: vi.fn(async (input: { page_id: string; properties: Record<string, unknown> }) => {
        const page = pages.get(input.page_id);
        if (!page) throw new Error(`Missing page ${input.page_id}`);
        page.properties = { ...page.properties, ...input.properties };
        return { id: page.id, url: `https://notion.local/${page.id}` };
      }),
    },
    blocks: {
      children: {
        list: vi.fn(async (input: { block_id: string }) => ({ results: pages.get(input.block_id)?.children ?? [] })),
      },
    },
    _pages: pages,
  };
}

function blockText(blocks: unknown[]): string {
  return blocks
    .map((block) => {
      const candidate = block as {
        paragraph?: { rich_text?: Array<{ text?: { content?: string } }> };
        heading_2?: { rich_text?: Array<{ text?: { content?: string } }> };
        bulleted_list_item?: { rich_text?: Array<{ text?: { content?: string } }> };
        numbered_list_item?: { rich_text?: Array<{ text?: { content?: string } }> };
      };
      return [
        ...(candidate.heading_2?.rich_text ?? []).map((part) => part.text?.content ?? ""),
        ...(candidate.paragraph?.rich_text ?? []).map((part) => part.text?.content ?? ""),
        ...(candidate.bulleted_list_item?.rich_text ?? []).map((part) => part.text?.content ?? ""),
        ...(candidate.numbered_list_item?.rich_text ?? []).map((part) => part.text?.content ?? ""),
      ].join("");
    })
    .filter(Boolean)
    .join("\n");
}

function parseTool<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0].text) as T;
}

async function seedProject(projectId: string) {
  const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-narratives-"));
  testContext.store = new StateStore(join(stateDir, "state.json"));
  testContext.notion = createFakeNotion();
  await testContext.store.upsertProject({
    projectId,
    projectName: "Acme App",
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
    featuresByKey: {},
    eventsByExternalId: {},
    eventSnapshots: {},
  });
}

describe("narratives-reach-authoring", () => {
  beforeEach(() => {
    testContext.notion = null;
    testContext.store = null;
  });

  it("generatedNarratives are returned by analysis instead of being stripped", async () => {
    await seedProject("project_analysis");
    await testContext.store?.setEventSnapshot("project_analysis", "evt_1", {
      summary: "Added billing export",
      diffSummary: "Added POST /api/billing/export",
      filesChanged: ["src/routes/billing/export.ts"],
      eventType: "commit",
      source: "local_git",
      testStatus: "passed",
      branch: "feature/billing-export",
    });

    const server = new FakeServer();
    registerAnalyzeDocumentationCandidateTool(server as unknown as McpServer);
    const analyze = server.handlers.get("analyze_documentation_candidate");
    expect(analyze).toBeDefined();

    const result = parseTool<{ generatedNarratives?: { providerUsed?: string; userGuide?: { summary?: string } } }>(
      await analyze!({ projectId: "project_analysis", evidenceEventIds: ["evt_1"] }),
    );

    expect(result.generatedNarratives?.providerUsed).toBe("test-provider");
    expect(result.generatedNarratives?.userGuide?.summary).toContain("PROVIDER USER NARRATIVE");
  });

  it("orchestrator passes provider narratives into authored User and Admin manual entries", async () => {
    const previousToken = process.env.NOTION_TOKEN;
    const previousAllowedRoots = process.env.AUTO_DOC_ALLOWED_REPO_ROOTS;
    process.env.NOTION_TOKEN = "test_token";
    try {
      const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-narratives-repo-"));
      process.env.AUTO_DOC_ALLOWED_REPO_ROOTS = repoPath;
      await seedProject("project_orchestrator");
      const server = new FakeServer();
      registerRunAutonomousDocumentationTriggerTool(server as unknown as McpServer);
      const handler = server.handlers.get("run_autonomous_documentation_trigger");
      expect(handler).toBeDefined();

      await handler!({
        projectId: "project_orchestrator",
        repoPath,
        mode: "last_commit",
        source: "local_git",
        eventType: "commit",
        summary: "Added billing export",
        diffSummary: "Repo evidence excerpt:\nGET POST MCP HTTP\nAdded POST /api/billing/export",
        filesChanged: ["src/routes/billing/export.ts"],
        testStatus: "passed",
      });

      const manualPages = Array.from(testContext.notion?._pages.values() ?? []).filter((page) => page.parent.database_id === "manual_entries_db");
      expect(manualPages.length).toBeGreaterThanOrEqual(2);
      const manualText = manualPages.map((page) => blockText(page.children)).join("\n\n");

      expect(manualText).toContain("PROVIDER USER NARRATIVE");
      expect(manualText).toContain("PROVIDER ADMIN VERIFY");
      expect(manualText).not.toContain("Source context:");
      expect(manualText).not.toMatch(/\b(GET|POST|MCP|HTTP)\b\s*$/m);
    } finally {
      if (previousToken === undefined) delete process.env.NOTION_TOKEN;
      else process.env.NOTION_TOKEN = previousToken;
      if (previousAllowedRoots === undefined) delete process.env.AUTO_DOC_ALLOWED_REPO_ROOTS;
      else process.env.AUTO_DOC_ALLOWED_REPO_ROOTS = previousAllowedRoots;
    }
  });
});
