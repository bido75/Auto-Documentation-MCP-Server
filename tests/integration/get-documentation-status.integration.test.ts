import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";

const testContext = vi.hoisted(() => {
  return {
    notion: null as unknown,
    store: null as StateStore | null,
  };
});

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

describe("get_documentation_status", () => {
  it("computes counts and missing review questions from Notion data", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-status-"));
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

    const query = vi.fn(async (input: { database_id: string; filter?: { and?: Array<Record<string, unknown>> } }) => {
      if (input.database_id === "db_releases") {
        return {
          results: [{ id: "release_page_1", properties: {} }],
          has_more: false,
          next_cursor: null,
        };
      }

      if (input.database_id === "db_manual") {
        const releaseFilterPresent =
          input.filter?.and?.some((clause) => (clause as { property?: string }).property === "Release") ?? false;
        if (releaseFilterPresent) {
          return {
            results: [
              {
                id: "entry_1",
                properties: {
                  Status: { status: { name: "Published" } },
                  "Confidence Score": { number: 96 },
                  "Entry Title": { title: [{ text: { content: "Invoice Export" } }] },
                  "Reviewer Notes": { rich_text: [] },
                },
              },
              {
                id: "entry_2",
                properties: {
                  Status: { status: { name: "Needs Review" } },
                  "Confidence Score": { number: 52 },
                  "Entry Title": { title: [{ text: { content: "Webhook Setup" } }] },
                  "Reviewer Notes": { rich_text: [] },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          };
        }
      }

      return { results: [], has_more: false, next_cursor: null };
    });

    testContext.notion = {
      databases: {
        query,
      },
    };

    const server = new FakeServer();
    const { registerGetDocumentationStatusTool } = await import("../../src/tools/get-documentation-status.js");
    registerGetDocumentationStatusTool(server as never);

    const getStatus = server.handlers.get("get_documentation_status");
    expect(getStatus).toBeDefined();

    const result = parseToolResult<{
      publishedCount: number;
      needsReviewCount: number;
      capturedCount: number;
      lowConfidenceCount: number;
      missingReviewQuestions: string[];
      health: string;
    }>(
      await getStatus!({
        projectId: "proj_1",
        releaseVersion: "1.0.0",
      }),
    );

    expect(result.publishedCount).toBe(1);
    expect(result.needsReviewCount).toBe(1);
    expect(result.capturedCount).toBe(0);
    expect(result.lowConfidenceCount).toBe(1);
    expect(result.missingReviewQuestions).toContain("Missing reviewer notes for 'Webhook Setup'.");
    expect(result.health).toBe("Needs Review");
  });
});
