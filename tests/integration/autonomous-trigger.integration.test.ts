import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { registerRunAutonomousDocumentationTriggerTool } from "../../src/tools/run-autonomous-documentation-trigger.js";

const testContext = vi.hoisted(() => ({
  notion: null as unknown,
  store: null as StateStore | null,
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => testContext.notion,
}));

vi.mock("../../src/providers/factory.js", () => ({
  analyzeWithFallback: vi.fn(async () => ({
    featureName: "Billing Settings Page With Invoice Export Workflow For Users",
    featureKey: "provider:billing-settings-export",
    shouldDocument: true,
    audiences: ["User"],
    userGuide: {
      summary: "Users can export invoices from the billing settings page.",
      steps: ["Open billing settings", "Select export invoices", "Download the invoice export"],
      expectedOutcome: "The invoice export downloads successfully.",
      possibleErrors: ["Check billing permissions if export is unavailable"],
    },
    adminGuide: {
      configRequired: ["No new configuration required"],
      endpointsAffected: [],
      envVarsRequired: [],
      verificationSteps: ["Confirm billing users can see export invoices"],
      troubleshooting: [],
    },
    confidenceScore: 86,
    confidenceReasons: ["Provider generated billing workflow documentation."],
    reviewQuestions: [],
    providerUsed: "test-provider",
    generationMs: 1,
  })),
  embedText: vi.fn(async () => [1, 0, 0]),
}));

vi.mock("../../src/lib/state-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/state-store.js")>("../../src/lib/state-store.js");
  return {
    ...actual,
    getStateStore: () => {
      if (!testContext.store) {
        throw new Error("Test store not initialized");
      }
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
  const title = (property as { title?: Array<{ text?: { content?: string } }> } | undefined)?.title;
  return title?.[0]?.text?.content ?? "";
}

function richText(property: unknown): string {
  const text = (property as { rich_text?: Array<{ text?: { content?: string } }> } | undefined)?.rich_text;
  return text?.[0]?.text?.content ?? "";
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
      const expected = (clause.rich_text as { equals?: string }).equals;
      return expected === undefined || richText(property) === expected;
    }
    if (clause.relation && typeof clause.relation === "object") {
      const expected = (clause.relation as { contains?: string }).contains;
      return expected === undefined || relationIds(property).includes(expected);
    }
    if (clause.title && typeof clause.title === "object") {
      const expected = (clause.title as { equals?: string }).equals;
      return expected === undefined || titleText(property) === expected;
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

function parseTool<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0].text) as T;
}

describe("run_autonomous_documentation_trigger", () => {
  it("captures, analyzes, upserts, publishes, and is idempotent for the same trigger", async () => {
    const previousToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = "test_token";

    try {
      const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-autonomous-"));
      testContext.store = new StateStore(join(stateDir, "state.json"));
      testContext.notion = createFakeNotion();

      await testContext.store.upsertProject({
        projectId: "project_1",
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

      const server = new FakeServer();
      registerRunAutonomousDocumentationTriggerTool(server as never);
      const handler = server.handlers.get("run_autonomous_documentation_trigger");
      expect(handler).toBeDefined();

      const input = {
        projectId: "project_1",
        repoPath: "C:/repo",
        mode: "last_commit",
        source: "local_git",
        eventType: "commit",
        summary: "Added billing settings page with invoice export workflow for users",
        diffSummary: "Added route /billing/settings and export button",
        filesChanged: ["src/routes/billing/settings.tsx", "src/components/InvoiceExport.tsx"],
        commitSha: "abc123",
        branch: "feature/billing-export",
        testStatus: "passed",
      };

      const first = parseTool<{
        ok: true;
        disposition: string;
        capture: { evidenceEventId: string };
        analysis: { shouldDocument: boolean; featureKey: string; confidenceScore: number };
        upsert: { featureId: string; manualEntryIds: string[] };
        publish: { finalStatus: string };
      }>(await handler!(input));

      expect(first.ok).toBe(true);
      expect(first.disposition).toBe("documented");
      expect(first.capture.evidenceEventId).toMatch(/^evt_/);
      expect(first.analysis.shouldDocument).toBe(true);
      expect(first.analysis.confidenceScore).toBeGreaterThanOrEqual(60);
      expect(first.upsert.featureId).toMatch(/^page_/);
      expect(first.upsert.manualEntryIds).toHaveLength(1);
      expect(first.publish.finalStatus).toBe("Published");

      const pagesAfterFirst = Array.from(testContext.notion._pages.values()) as FakePage[];
      expect(pagesAfterFirst.filter((page) => page.parent.database_id === "events_db")).toHaveLength(1);
      expect(pagesAfterFirst.filter((page) => page.parent.database_id === "features_db")).toHaveLength(1);
      expect(pagesAfterFirst.filter((page) => page.parent.database_id === "manual_entries_db")).toHaveLength(1);

      const second = parseTool<{ disposition: string; upsert: { featureId: string; manualEntryIds: string[] } | null }>(await handler!(input));
      expect(second.disposition).toBe("duplicate");
      expect(second.upsert).toBeNull();

      const pagesAfterSecond = Array.from(testContext.notion._pages.values()) as FakePage[];
      expect(pagesAfterSecond.filter((page) => page.parent.database_id === "features_db")).toHaveLength(1);
      expect(pagesAfterSecond.filter((page) => page.parent.database_id === "manual_entries_db")).toHaveLength(1);
    } finally {
      if (previousToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = previousToken;
      }
    }
  });
});
