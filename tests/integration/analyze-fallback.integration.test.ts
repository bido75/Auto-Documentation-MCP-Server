import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import type { AnalyzeDocumentationCandidateResult } from "../../src/types.js";

const testContext = vi.hoisted(() => {
  return {
    notion: null as unknown,
    store: null as StateStore | null,
  };
});

vi.mock("../../src/analysis/manual-worthiness.js", () => ({
  classifyManualWorthiness: vi.fn(() => {
    throw new Error("simulated analyzer failure");
  }),
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => testContext.notion,
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

function parseToolResult<T>(value: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(value.content[0].text) as T;
}

describe("analyze_documentation_candidate fallback", () => {
  it("captures analyzer failures as a Notion manual entry with Captured status", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-analyze-fallback-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.upsertProject({
      projectId: "proj_1",
      projectName: "Acme",
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
      summary: "Added billing export flow",
      filesChanged: ["src/routes/billing/export.tsx"],
      eventType: "commit",
      source: "local_git",
      commitSha: "abc123",
      testStatus: "passed",
    });

    const create = vi.fn(async () => ({ id: "manual_fallback_1" }));

    testContext.notion = {
      pages: {
        create,
      },
    };

    const server = new FakeServer();
    const { registerAnalyzeDocumentationCandidateTool } = await import("../../src/tools/analyze-documentation-candidate.js");
    registerAnalyzeDocumentationCandidateTool(server as never);

    const analyze = server.handlers.get("analyze_documentation_candidate");
    expect(analyze).toBeDefined();

    const result = parseToolResult<AnalyzeDocumentationCandidateResult>(
      await analyze!({
        projectId: "proj_1",
        evidenceEventIds: ["evt_1"],
      }),
    );

    expect(result.shouldDocument).toBe(false);
    expect(result.confidenceScore).toBe(0);
    expect(result.fallbackStatus).toBe("Captured");
    expect(result.fallbackEntryId).toBe("manual_fallback_1");
    expect(result.fallbackReasonCode).toBe("analyzer_exception_fallback_persisted");
    expect(result.confidenceReasons.join(" ")).toContain("Analyzer failed");

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: { database_id: "db_manual" },
        properties: expect.objectContaining({
          Status: { status: { name: "Captured" } },
          "Publishing Decision": { select: { name: "Queued Review" } },
          Project: { relation: [{ id: "project_page_1" }] },
        }),
      }),
    );
  });

  it("returns a deterministic fallback reason code when no usable evidence exists", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-analyze-no-evidence-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.upsertProject({
      projectId: "proj_2",
      projectName: "Acme",
      parentPageId: "parent_1",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      projectPageId: "project_page_2",
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

    testContext.notion = {
      pages: {
        create: vi.fn(async () => ({ id: "unused" })),
      },
    };

    const server = new FakeServer();
    const { registerAnalyzeDocumentationCandidateTool } = await import("../../src/tools/analyze-documentation-candidate.js");
    registerAnalyzeDocumentationCandidateTool(server as never);

    const analyze = server.handlers.get("analyze_documentation_candidate");
    expect(analyze).toBeDefined();

    const result = parseToolResult<AnalyzeDocumentationCandidateResult>(
      await analyze!({
        projectId: "proj_2",
        evidenceEventIds: ["evt_missing"],
      }),
    );

    expect(result.shouldDocument).toBe(false);
    expect(result.fallbackStatus).toBe("Captured");
    expect(result.fallbackEntryId).toBeNull();
    expect(result.fallbackReasonCode).toBe("no_usable_evidence");
  });
});
