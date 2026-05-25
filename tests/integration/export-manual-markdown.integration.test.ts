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

describe("export_manual_markdown", () => {
  it("loads project name and published entries from Notion when caller does not provide entries", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-export-"));
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
      databases: {
        query: vi.fn(async () => ({
          results: [
            {
              id: "manual_1",
              properties: {
                "Entry Title": { title: [{ text: { content: "Export invoices" } }] },
                "Entry Type": { select: { name: "User Guide" } },
                Audience: { select: { name: "User" } },
                Status: { status: { name: "Published" } },
              },
            },
          ],
        })),
      },
      blocks: {
        children: {
          list: vi.fn(async () => ({
            results: [
              {
                type: "paragraph",
                paragraph: {
                  rich_text: [{ plain_text: "Go to Billing Settings and click Export." }],
                },
              },
            ],
          })),
        },
      },
    };

    const server = new FakeServer();
    const { registerExportManualMarkdownTool } = await import("../../src/tools/export-manual-markdown.js");
    registerExportManualMarkdownTool(server as never);

    const exportManual = server.handlers.get("export_manual_markdown");
    expect(exportManual).toBeDefined();

    const result = parseToolResult<{ projectId: string; markdown: string }>(
      await exportManual!({
        projectId: "proj_1",
        audience: "both",
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.markdown).toContain("# Acme Manual Export");
    expect(result.markdown).toContain("## Export invoices");
    expect(result.markdown).toContain("Go to Billing Settings and click Export.");
  });
});
