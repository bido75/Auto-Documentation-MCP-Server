import { readFile } from "node:fs/promises";
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

describe("export_help_center_content", () => {
  it("exports published entries as sectioned help center JSON and writes output file", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-help-center-"));
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

    testContext.notion = {
      users: {
        me: vi.fn(async () => ({ object: "user" })),
      },
      databases: {
        retrieve: vi.fn(async () => ({ object: "database" })),
        query: vi.fn(async (payload: Record<string, unknown>) => {
          if (payload.database_id === "db_releases") {
            return {
              results: [
                {
                  id: "release_2_0_0",
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
                  "Entry Title": { title: [{ text: { content: "Bulk Export" } }] },
                  "Entry Type": { select: { name: "User Guide" } },
                  Audience: { select: { name: "User" } },
                  Status: { status: { name: "Published" } },
                },
              },
              {
                id: "entry_2",
                properties: {
                  "Entry Title": { title: [{ text: { content: "Webhook Rotation" } }] },
                  "Entry Type": { select: { name: "Admin Guide" } },
                  Audience: { select: { name: "Admin" } },
                  Status: { status: { name: "Published" } },
                },
              },
              {
                id: "entry_3",
                properties: {
                  "Entry Title": { title: [{ text: { content: "Internal Refactor" } }] },
                  "Entry Type": { select: { name: "Developer Note" } },
                  Audience: { select: { name: "Internal" } },
                  Status: { status: { name: "Published" } },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          };
        }),
      },
      blocks: {
        children: {
          list: vi.fn(async (payload: Record<string, unknown>) => {
            if (payload.block_id === "entry_1") {
              return {
                results: [
                  {
                    type: "paragraph",
                    paragraph: {
                      rich_text: [{ plain_text: "Go to Billing and click Export." }],
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
                      rich_text: [{ plain_text: "Rotate the webhook signing key monthly." }],
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
                    rich_text: [{ plain_text: "Not for external help center." }],
                  },
                },
              ],
            };
          }),
        },
      },
    };

    const server = new FakeServer();
    const { registerExportHelpCenterContentTool } = await import("../../src/tools/export-help-center-content.js");
    registerExportHelpCenterContentTool(server as never);

    const exportHelpCenter = server.handlers.get("export_help_center_content");
    expect(exportHelpCenter).toBeDefined();

    const outputPath = join(stateDir, "docs", "help-center.json");

    const result = parseToolResult<{
      projectId: string;
      audience: string;
      sectionCount: number;
      articleCount: number;
      sections: Array<{ title: string; articleCount: number; articles: Array<{ title: string; summary: string }> }>;
      outputPath: string | null;
    }>(
      await exportHelpCenter!({
        projectId: "proj_1",
        audience: "both",
        releaseVersion: "2.0.0",
        outputPath,
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.audience).toBe("both");
    expect(result.sectionCount).toBe(2);
    expect(result.articleCount).toBe(2);
    expect(result.sections.map((section) => section.title).sort()).toEqual(["Admin Guide", "User Guide"]);
    expect(result.sections.find((section) => section.title === "User Guide")?.articles[0]?.title).toBe("Bulk Export");
    expect(result.sections.find((section) => section.title === "Admin Guide")?.articles[0]?.summary).toContain("Rotate the webhook signing key monthly");
    expect(result.outputPath).toBe(outputPath);

    const fileContents = await readFile(outputPath, "utf-8");
    expect(fileContents).toContain("\"sectionCount\": 2");
    expect(fileContents).toContain("\"title\": \"Bulk Export\"");
  });
});
