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

describe("generate_release_changelog", () => {
  it("builds changelog markdown for published/approved entries linked to a release", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-changelog-"));
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
      const databaseId = payload.database_id;
      if (databaseId === "db_releases") {
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
              "Entry Title": { title: [{ text: { content: "Bulk export from billing dashboard" } }] },
              "Entry Type": { select: { name: "User Guide" } },
              Audience: { select: { name: "User" } },
              "Confidence Score": { number: 95 },
            },
          },
          {
            id: "entry_2",
            properties: {
              "Entry Title": { title: [{ text: { content: "New export retention policy" } }] },
              "Entry Type": { select: { name: "Admin Guide" } },
              Audience: { select: { name: "Admin" } },
              "Confidence Score": { number: 82 },
            },
          },
          {
            id: "entry_3",
            properties: {
              "Entry Title": { title: [{ text: { content: "Indexer tuning" } }] },
              "Entry Type": { select: { name: "Developer Note" } },
              Audience: { select: { name: "Internal" } },
              "Confidence Score": { number: 70 },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      };
    });

    const list = vi.fn(async (payload: Record<string, unknown>) => {
      if (payload.block_id === "entry_1") {
        return {
          results: [
            {
              type: "paragraph",
              paragraph: {
                rich_text: [{ plain_text: "Users can export all invoices from Billing in one action." }],
              },
            },
          ],
        };
      }

      if (payload.block_id === "entry_2") {
        return {
          results: [
            {
              type: "paragraph",
              paragraph: {
                rich_text: [{ plain_text: "Admins can configure retention period per workspace." }],
              },
            },
          ],
        };
      }

      return {
        results: [
          {
            type: "paragraph",
            paragraph: {
              rich_text: [{ plain_text: "Reduced reindex time for large tenants." }],
            },
          },
        ],
      };
    });

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
    const { registerGenerateReleaseChangelogTool } = await import("../../src/tools/generate-release-changelog.js");
    registerGenerateReleaseChangelogTool(server as never);

    const generate = server.handlers.get("generate_release_changelog");
    expect(generate).toBeDefined();

    const result = parseToolResult<{
      projectId: string;
      releaseVersion: string;
      releaseLinked: boolean;
      entryCount: number;
      sectionCounts: {
        userImpact: number;
        adminOperations: number;
        developerNotes: number;
      };
      changelogMarkdown: string;
    }>(
      await generate!({
        projectId: "proj_1",
        releaseVersion: "2.0.0",
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.releaseVersion).toBe("2.0.0");
    expect(result.releaseLinked).toBe(true);
    expect(result.entryCount).toBe(3);
    expect(result.sectionCounts.userImpact).toBe(1);
    expect(result.sectionCounts.adminOperations).toBe(1);
    expect(result.sectionCounts.developerNotes).toBe(1);
    expect(result.changelogMarkdown).toContain("# Acme App - 2.0.0 Changelog");
    expect(result.changelogMarkdown).toContain("## User Impact");
    expect(result.changelogMarkdown).toContain("## Admin / Operations");
    expect(result.changelogMarkdown).toContain("## Developer Notes");
    expect(result.changelogMarkdown).toContain("Bulk export from billing dashboard");
    expect(result.changelogMarkdown).toContain("New export retention policy");
    expect(result.changelogMarkdown).toContain("Indexer tuning");
  });
});
