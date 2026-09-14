import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { registerRunAutonomousDocumentationTriggerTool } from "../../src/tools/run-autonomous-documentation-trigger.js";

const testContext = vi.hoisted(() => ({
  store: null as StateStore | null,
  notion: null as ReturnType<typeof createFakeNotion> | null,
}));

vi.mock("../../src/providers/factory.js", () => ({
  analyzeWithFallback: vi.fn(async () => ({
    providerUsed: "cloud-openai:qwen/qwen3.6-flash",
    generationMs: 1,
    message: "not the expected analyzer schema",
  })),
  embedText: vi.fn(async () => []),
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => {
    if (!testContext.notion) throw new Error("No fake Notion");
    return testContext.notion;
  },
}));

vi.mock("../../src/lib/state-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/state-store.js")>("../../src/lib/state-store.js");
  return {
    ...actual,
    getStateStore: () => {
      if (!testContext.store) throw new Error("No fake store");
      return testContext.store;
    },
  };
});

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

function createFakeNotion() {
  let counter = 0;
  return {
    users: { me: vi.fn(async () => ({ id: "user_1" })) },
    databases: {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({ id: database_id })),
      query: vi.fn(async () => ({ results: [] })),
    },
    pages: {
      create: vi.fn(async () => {
        counter += 1;
        return { id: `page_${counter}`, url: `https://notion.local/page_${counter}` };
      }),
      update: vi.fn(async ({ page_id }: { page_id: string }) => ({ id: page_id, url: `https://notion.local/${page_id}` })),
    },
    blocks: { children: { list: vi.fn(async () => ({ results: [] })) } },
  };
}

function parseTool<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0].text) as T;
}

describe("run result truthful counts", () => {
  it("surfaces analyzer failures instead of reporting a green documented run", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-truthful-counts-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));
    testContext.notion = createFakeNotion();

    await testContext.store.upsertProject({
      projectId: "project_1",
      projectName: "Auto-Doc",
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
    const result = parseTool<{
      ok: true;
      disposition: string;
      documentedFeatureCount: number;
      analyzerFailureCount: number;
      skippedCount: number;
      duplicateCount: number;
      analysis: { fallbackReasonCode: string; fallbackStatus: string | null };
      upsert: null;
      publish: null;
    }>(
      await server.handlers.get("run_autonomous_documentation_trigger")!({
        projectId: "project_1",
        mode: "working_tree",
        summary: "Document the autonomous pipeline",
        diffSummary: "Provider returned malformed analyzer JSON.",
        filesChanged: ["src/lib/analyzer.ts"],
        testStatus: "passed",
      }),
    );

    expect(result.disposition).toBe("skipped");
    expect(result.documentedFeatureCount).toBe(0);
    expect(result.analyzerFailureCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.duplicateCount).toBe(0);
    expect(result.analysis.fallbackReasonCode).toBe("provider_output_invalid");
    expect(result.analysis.fallbackStatus).toBeNull();
    expect(result.upsert).toBeNull();
    expect(result.publish).toBeNull();
  });
});
