import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";

const testContext = vi.hoisted(() => ({
  store: null as StateStore | null,
  notion: { pages: { create: vi.fn() } },
}));

vi.mock("../../src/providers/factory.js", () => ({
  analyzeWithFallback: vi.fn(async () => ({
    providerUsed: "cloud-openai:qwen/qwen3.6-flash",
    generationMs: 1,
    message: "I cannot produce JSON for this request.",
  })),
  embedText: vi.fn(async () => []),
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => testContext.notion,
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

function parseResult<T>(result: { content: Array<{ text: string }> }): T {
  return JSON.parse(result.content[0].text) as T;
}

describe("analyzer honest failure", () => {
  it("returns provider_output_invalid without persisting a Captured fallback shell", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-analyzer-invalid-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));
    testContext.notion.pages.create.mockClear();

    await testContext.store.upsertProject({
      projectId: "proj_1",
      projectName: "Auto-Doc",
      parentPageId: "parent_1",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      projectPageId: "project_page_1",
      databases: {
        projectsDatabaseId: "db_projects",
        featuresDatabaseId: "db_features",
        manualEntriesDatabaseId: "db_manual",
        evidenceEventsDatabaseId: "db_evidence",
        releasesDatabaseId: "db_releases",
      },
      featuresByKey: {},
      eventsByExternalId: {},
      eventSnapshots: {},
    });
    await testContext.store.setEventSnapshot("proj_1", "evt_1", {
      summary: "Added autonomous self documentation",
      filesChanged: ["src/orchestrator/auto-doc-orchestrator.ts"],
      eventType: "commit",
      source: "local_git",
      testStatus: "passed",
    });

    const server = new FakeServer();
    const { registerAnalyzeDocumentationCandidateTool } = await import("../../src/tools/analyze-documentation-candidate.js");
    registerAnalyzeDocumentationCandidateTool(server as never);

    const result = parseResult<{
      shouldDocument: boolean;
      fallbackStatus: string | null;
      fallbackEntryId: string | null;
      fallbackReasonCode: string;
      confidenceReasons: string[];
    }>(await server.handlers.get("analyze_documentation_candidate")!({ projectId: "proj_1", evidenceEventIds: ["evt_1"] }));

    expect(result.shouldDocument).toBe(false);
    expect(result.fallbackStatus).toBeNull();
    expect(result.fallbackEntryId).toBeNull();
    expect(result.fallbackReasonCode).toBe("provider_output_invalid");
    expect(result.confidenceReasons.join(" ")).toContain("Provider output invalid");
    expect(testContext.notion.pages.create).not.toHaveBeenCalled();
  });
});
