/**
 * Acceptance: Visual feature criterion 4 - export/packaging includes visuals
 * markdown references figures; PDF embeds them; figure-less export unchanged.
 * All file access via path-safety helper. DO NOT DELETE/SKIP.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderManualMarkdown } from "../../src/lib/export.js";
import { buildMarkdownManual } from "../../src/packaging/manual-packager.js";
import { StateStore } from "../../src/lib/state-store.js";

const testContext = vi.hoisted(() => ({
  notion: null as ReturnType<typeof createFakeNotion> | null,
  store: null as StateStore | null,
  pdfInputs: [] as Array<{ markdown: string; outputPath: string; title: string }>,
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => {
    if (!testContext.notion) throw new Error("Test Notion client not initialized");
    return testContext.notion;
  },
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

vi.mock("../../src/lib/pdf.js", () => ({
  generatePdfFromMarkdown: vi.fn(async (input: { markdown: string; outputPath: string; title: string }) => {
    testContext.pdfInputs.push(input);
    return input.outputPath;
  }),
}));

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;
type FakePage = { id: string; parent: { database_id: string }; properties: Record<string, unknown>; children: Record<string, unknown>[] };

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();
  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

function createFakeNotion() {
  const pages = new Map<string, FakePage>();
  return {
    users: { me: vi.fn(async () => ({ id: "user_1" })) },
    databases: {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({ id: database_id })),
      query: vi.fn(async (input: { database_id: string }) => ({
        results: [...pages.values()].filter((page) => page.parent.database_id === input.database_id).map((page) => ({ id: page.id, properties: page.properties })),
      })),
    },
    pages: {
      update: vi.fn(async ({ page_id }: { page_id: string }) => ({ id: page_id })),
      create: vi.fn(async () => ({ id: "release_2", url: "https://notion.local/release_2" })),
    },
    blocks: {
      children: {
        list: vi.fn(async ({ block_id }: { block_id: string }) => ({ results: pages.get(block_id)?.children ?? [] })),
      },
    },
    _addPage: (page: FakePage) => pages.set(page.id, page),
  };
}

async function setupProject() {
  const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-export-visuals-"));
  process.env.AUTO_DOC_ARTIFACT_ROOT = join(stateDir, "artifacts");
  testContext.store = new StateStore(join(stateDir, "state.json"));
  testContext.notion = createFakeNotion();
  await testContext.store.upsertProject({
    projectId: "project_1",
    projectName: "Acme",
    parentPageId: "parent_1",
    publishingMode: "Balanced",
    autoPublishThreshold: 90,
    projectPageId: "project_page_1",
    databases: {
      projectsDatabaseId: "projects_db",
      featuresDatabaseId: "features_db",
      manualEntriesDatabaseId: "manual_db",
      evidenceEventsDatabaseId: "events_db",
      releasesDatabaseId: "releases_db",
    },
    featuresByKey: {},
    eventsByExternalId: {},
    eventSnapshots: {},
  });
  testContext.notion._addPage({
    id: "manual_1",
    parent: { database_id: "manual_db" },
    properties: {
      "Entry Title": { title: [{ text: { content: "Export invoices" } }] },
      "Entry Type": { select: { name: "User Guide" } },
      Audience: { select: { name: "User" } },
      Status: { status: { name: "Published" } },
      Project: { relation: [{ id: "project_page_1" }] },
    },
    children: [
      { type: "paragraph", paragraph: { rich_text: [{ plain_text: "Open Billing Settings." }] } },
      {
        type: "image",
        image: {
          type: "external",
          external: { url: "https://cdn.example.test/export.png" },
          caption: [{ plain_text: "Export button highlighted" }],
        },
      },
    ],
  });
}

function parseToolResult<T>(value: ToolResult): T {
  return JSON.parse(value.content[0].text) as T;
}

beforeEach(() => {
  testContext.notion = null;
  testContext.store = null;
  testContext.pdfInputs = [];
  delete process.env.AUTO_DOC_ARTIFACT_ROOT;
});

describe("export-includes-visuals", () => {
  it("export_manual_markdown references the figure files resolvable from the artifact root", async () => {
    await setupProject();
    const server = new FakeServer();
    const { registerExportManualMarkdownTool } = await import("../../src/tools/export-manual-markdown.js");
    registerExportManualMarkdownTool(server as unknown as McpServer);

    const result = parseToolResult<{ markdown: string }>(await server.handlers.get("export_manual_markdown")!({ projectId: "project_1", audience: "both" }));

    expect(result.markdown).toContain("![Export button highlighted](https://cdn.example.test/export.png)");
    expect(result.markdown).toContain("_Export button highlighted_");
  });

  it("export_manual_pdf embeds the figure images in the output PDF", async () => {
    await setupProject();
    const server = new FakeServer();
    const { registerExportManualPdfTool } = await import("../../src/tools/export-manual-pdf.js");
    registerExportManualPdfTool(server as unknown as McpServer);

    await server.handlers.get("export_manual_pdf")!({ projectId: "project_1", releaseVersion: "1.0.0", outputPath: "manuals/release.pdf" });

    expect(testContext.pdfInputs[0].markdown).toContain("![Export button highlighted](https://cdn.example.test/export.png)");
  });

  it("a figure-less manual exports identically to pre-feature behavior", () => {
    const before = "# Acme Manual Export\n\n## Export invoices\n\nType: User Guide\n\nOpen Billing Settings.\n";
    expect(
      renderManualMarkdown({
        projectName: "Acme",
        audience: "both",
        entries: [{ title: "Export invoices", entryType: "User Guide", audience: "User", status: "Published", body: "Open Billing Settings." }],
      }),
    ).toBe(before);
  });

  it("package_manual includes figures in the packaged release", async () => {
    await setupProject();
    const server = new FakeServer();
    const { registerPackageManualTool } = await import("../../src/tools/package-manual.js");
    registerPackageManualTool(server as unknown as McpServer);

    const result = parseToolResult<{ output: string }>(
      await server.handlers.get("package_manual")!({
        projectId: "project_1",
        releaseVersion: "1.0.0",
        audience: "both",
        format: "markdown",
      }),
    );

    expect(result.output).toContain("![Export button highlighted](https://cdn.example.test/export.png)");
    expect(buildMarkdownManual({ projectName: "Acme", releaseVersion: "1.0.0", audience: "User", entries: [] })).not.toContain("![");
  });
});
