import { mkdtemp, readFile } from "node:fs/promises";
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

describe("sync_manual_to_local_docs", () => {
  it("writes published entries from Notion into local docs markdown", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-sync-local-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.upsertProject({
      projectId: "proj_1",
      projectName: "Acme App",
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

    const query = vi.fn(async (payload: Record<string, unknown>) => {
      if (payload.database_id === "db_releases") {
        return {
          results: [
            {
              id: "release_page_1",
              properties: {
                "Release Version": { title: [{ text: { content: "2.0.0" } }] },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        };
      }

      return {
        results: [
          {
            id: "entry_1",
            properties: {
              "Entry Title": { title: [{ text: { content: "Bulk export from billing" } }] },
              "Entry Type": { select: { name: "User Guide" } },
              Audience: { select: { name: "User" } },
              Status: { status: { name: "Published" } },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      };
    });

    const list = vi.fn(async () => ({
      results: [
        {
          type: "paragraph",
          paragraph: {
            rich_text: [{ plain_text: "Users can export invoices in one click." }],
          },
        },
      ],
    }));

    testContext.notion = {
      users: {
        me: vi.fn(async () => ({ object: "user" })),
      },
      databases: {
        retrieve: vi.fn(async () => ({ object: "database" })),
        query,
      },
      blocks: {
        children: {
          list,
        },
      },
    };

    const server = new FakeServer();
    const { registerSyncManualToLocalDocsTool } = await import("../../src/tools/sync-manual-to-local-docs.js");
    registerSyncManualToLocalDocsTool(server as never);

    const sync = server.handlers.get("sync_manual_to_local_docs");
    expect(sync).toBeDefined();

    const outputPath = join(stateDir, "docs", "MANUAL.md");
    const result = parseToolResult<{
      projectId: string;
      releaseVersion: string | null;
      outputPath: string;
      entryCount: number;
      byteLength: number;
    }>(
      await sync!({
        projectId: "proj_1",
        releaseVersion: "2.0.0",
        audience: "both",
        outputPath,
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.releaseVersion).toBe("2.0.0");
    expect(result.outputPath).toBe(outputPath);
    expect(result.entryCount).toBe(1);
    expect(result.byteLength).toBeGreaterThan(0);

    const fileContents = await readFile(outputPath, "utf-8");
    expect(fileContents).toContain("# Acme App Manual Export");
    expect(fileContents).toContain("Bulk export from billing");
    expect(fileContents).toContain("Users can export invoices in one click.");
  });
});
