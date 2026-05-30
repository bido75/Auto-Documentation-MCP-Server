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

vi.mock("../../src/lib/pdf.js", () => ({
  generatePdfFromMarkdown: vi.fn(async (input: { outputPath: string }) => input.outputPath),
}));

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

describe("export_manual_pdf", () => {
  it("exports release manual markdown to PDF path and returns counts", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-pdf-"));
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
              "Entry Title": { title: [{ text: { content: "Bulk export" } }] },
              Audience: { select: { name: "User" } },
              Status: { status: { name: "Published" } },
            },
          },
          {
            id: "entry_2",
            properties: {
              "Entry Title": { title: [{ text: { content: "Internal refactor notes" } }] },
              Audience: { select: { name: "Internal" } },
              Status: { status: { name: "Captured" } },
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
                rich_text: [{ plain_text: "Users can export invoices in one click." }],
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
              rich_text: [{ plain_text: "No visible behavior changes." }],
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
    const { registerExportManualPdfTool } = await import("../../src/tools/export-manual-pdf.js");
    registerExportManualPdfTool(server as never);

    const exportPdf = server.handlers.get("export_manual_pdf");
    expect(exportPdf).toBeDefined();

    const result = parseToolResult<{
      projectId: string;
      releaseVersion: string;
      audience: string;
      includedEntryCount: number;
      excludedEntryCount: number;
      outputPath: string;
    }>(
      await exportPdf!({
        projectId: "proj_1",
        releaseVersion: "2.0.0",
        audience: "both",
        outputPath: "./artifacts/release-2.0.0-manual.pdf",
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.releaseVersion).toBe("2.0.0");
    expect(result.audience).toBe("both");
    expect(result.includedEntryCount).toBe(1);
    expect(result.excludedEntryCount).toBe(1);
    expect(result.outputPath).toBe("./artifacts/release-2.0.0-manual.pdf");
  });
});
