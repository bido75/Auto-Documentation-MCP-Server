import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore, type ProjectState } from "../../src/lib/state-store.js";
import { registerGetDocumentationHealthTool } from "../../src/tools/get-documentation-health.js";

type ToolHandler = (input: { projectId: string; staleAfterDays?: number }) => Promise<{ content: Array<{ type: string; text: string }> }>;

const testContext = vi.hoisted(() => ({
  notion: null as unknown,
  store: null as StateStore | null,
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => testContext.notion,
}));

vi.mock("../../src/lib/notion-preflight.js", () => ({
  runProjectPreflight: vi.fn(async () => undefined),
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

function project(): ProjectState {
  return {
    projectId: "project_1",
    projectName: "Example",
    parentPageId: "parent_1",
    projectPageId: "project_page_1",
    publishingMode: "Balanced",
    autoPublishThreshold: 85,
    databases: {
      projectsDatabaseId: "projects_db",
      featuresDatabaseId: "features_db",
      manualEntriesDatabaseId: "entries_db",
      evidenceEventsDatabaseId: "events_db",
      releasesDatabaseId: "releases_db",
    },
    featuresByKey: {},
    eventsByExternalId: {},
    eventSnapshots: {},
  };
}

function makeNotion() {
  const features = [
    { id: "feature_1", properties: { Project: { relation: [{ id: "project_page_1" }] } } },
    { id: "feature_2", properties: { Project: { relation: [{ id: "project_page_1" }] } } },
  ];
  const entries = [
    {
      id: "entry_1",
      last_edited_time: new Date().toISOString(),
      properties: {
        Project: { relation: [{ id: "project_page_1" }] },
        Feature: { relation: [{ id: "feature_1" }] },
        Status: { status: { name: "Published" } },
        Audience: { select: { name: "User" } },
        "Confidence Score": { number: 92 },
        "Entry Title": { title: [{ plain_text: "Search User Guide" }] },
      },
    },
  ];

  return {
    databases: {
      query: vi.fn(async (input: { database_id: string }) => ({
        results: input.database_id === "features_db" ? features : entries,
        has_more: false,
        next_cursor: null,
      })),
    },
  };
}

describe("get_documentation_health", () => {
  it("computes coverage, grade, and entry breakdown from real tool handler logic", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-tool-"));
    testContext.store = new StateStore(join(dir, "state.json"));
    await testContext.store.upsertProject(project());
    testContext.notion = makeNotion();

    const handlers = new Map<string, ToolHandler>();
    registerGetDocumentationHealthTool({
      tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
      },
    } as never);

    const result = await handlers.get("get_documentation_health")?.({ projectId: "project_1", staleAfterDays: 30 });
    const payload = JSON.parse(result?.content[0]?.text ?? "{}") as {
      coverage: number;
      grade: string;
      totalFeatures: number;
      documentedFeatures: number;
      entries: { total: number; byStatus: Record<string, number>; byAudience: Record<string, number> };
    };

    expect(payload.coverage).toBe(50);
    expect(payload.grade).toBe("C");
    expect(payload.totalFeatures).toBe(2);
    expect(payload.documentedFeatures).toBe(1);
    expect(payload.entries.total).toBe(1);
    expect(payload.entries.byStatus.Published).toBe(1);
    expect(payload.entries.byAudience.User).toBe(1);
  });
});
