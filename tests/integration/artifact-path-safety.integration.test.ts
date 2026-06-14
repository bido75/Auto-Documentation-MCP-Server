import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { captureScreenshot } from "../../src/lib/screenshots.js";

const testContext = vi.hoisted(() => ({
  notion: null as ReturnType<typeof createFakeNotion> | null,
  pdfInputs: [] as Array<{ markdown: string; outputPath: string; title: string }>,
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => {
    if (!testContext.notion) {
      throw new Error("Test Notion client not initialized");
    }
    return testContext.notion;
  },
}));

vi.mock("../../src/lib/pdf.js", () => ({
  generatePdfFromMarkdown: vi.fn(async (input: { markdown: string; outputPath: string; title: string }) => {
    testContext.pdfInputs.push(input);
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(input.outputPath), { recursive: true });
    await writeFile(input.outputPath, `%PDF-1.4\n${input.title}\n${input.markdown}`, "utf8");
    return input.outputPath;
  }),
}));

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(async () => ({
      newPage: async () => ({
        goto: async () => undefined,
        screenshot: async ({ path }: { path: string }) => {
          const { mkdir, writeFile } = await import("node:fs/promises");
          const { dirname } = await import("node:path");
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, "png-bytes", "utf8");
        },
      }),
      close: async () => undefined,
    })),
  },
}));

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

type FakePage = {
  id: string;
  parent: { database_id: string };
  properties: Record<string, unknown>;
  children: Array<{ type: "paragraph"; paragraph: { rich_text: Array<{ plain_text: string }> } }>;
};

function title(value: string) {
  return { title: [{ text: { content: value }, plain_text: value }] };
}

function select(value: string) {
  return { select: { name: value } };
}

function statusValue(value: string) {
  return { status: { name: value } };
}

function relation(...ids: string[]) {
  return { relation: ids.map((id) => ({ id })) };
}

function paragraph(value: string): FakePage["children"][number] {
  return { type: "paragraph", paragraph: { rich_text: [{ plain_text: value }] } };
}

function createFakeNotion() {
  const pages = new Map<string, FakePage>();
  const textTitle = (property: unknown) => (property as { title?: Array<{ text?: { content?: string } }> } | undefined)?.title?.[0]?.text?.content;
  const relations = (property: unknown) => ((property as { relation?: Array<{ id?: string }> } | undefined)?.relation ?? []).map((item) => item.id);
  function matches(page: FakePage, filter: Record<string, unknown>): boolean {
    if (Array.isArray(filter.and)) return filter.and.every((item) => matches(page, item as Record<string, unknown>));
    const property = typeof filter.property === "string" ? page.properties[filter.property] : undefined;
    if (filter.relation) {
      const expected = (filter.relation as { contains?: string }).contains;
      return typeof expected === "string" && relations(property).includes(expected);
    }
    if (filter.title) return textTitle(property) === (filter.title as { equals?: string }).equals;
    if (filter.status) return (property as { status?: { name?: string } } | undefined)?.status?.name === (filter.status as { equals?: string }).equals;
    return true;
  }
  return {
    _addPage: (page: FakePage) => pages.set(page.id, page),
    users: { me: vi.fn(async () => ({ id: "user_1" })) },
    databases: {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({ id: database_id })),
      query: vi.fn(async (input: { database_id: string; filter?: Record<string, unknown> }) => ({
        results: [...pages.values()]
          .filter((page) => page.parent.database_id === input.database_id)
          .filter((page) => (input.filter ? matches(page, input.filter) : true))
          .map((page) => ({ id: page.id, properties: page.properties })),
        has_more: false,
        next_cursor: null,
      })),
    },
    blocks: {
      children: {
        list: vi.fn(async ({ block_id }: { block_id: string }) => ({ results: pages.get(block_id)?.children ?? [] })),
      },
    },
  };
}

async function setupProject() {
  const root = await mkdtemp(join(tmpdir(), "auto-doc-artifacts-"));
  const statePath = join(root, "state.json");
  process.env.AUTO_DOC_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AUTO_DOC_STATE_FILE = statePath;
  process.env.NOTION_TOKEN = "test_token";
  testContext.notion = createFakeNotion();
  const store = new StateStore(statePath);
  await store.upsertProject({
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
    id: "release_1",
    parent: { database_id: "releases_db" },
    properties: { "Release Version": title("1.0.0"), Project: relation("project_page_1") },
    children: [],
  });
  testContext.notion._addPage({
    id: "manual_1",
    parent: { database_id: "manual_db" },
    properties: {
      "Entry Title": title("Billing Export"),
      "Entry Type": select("User Guide"),
      Audience: select("User"),
      Status: statusValue("Published"),
      Project: relation("project_page_1"),
      Release: relation("release_1"),
    },
    children: [paragraph("Users can export invoices.")],
  });
  return { root, artifactRoot: process.env.AUTO_DOC_ARTIFACT_ROOT };
}

async function handlerFor(register: (server: McpServer) => void, name: string): Promise<ToolHandler> {
  const server = new FakeServer();
  register(server as unknown as McpServer);
  const handler = server.handlers.get(name);
  expect(handler).toBeDefined();
  return handler!;
}

function parseError(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  return JSON.parse((error as Error).message) as { error: { code: string } };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

beforeEach(() => {
  testContext.notion = null;
  testContext.pdfInputs = [];
  delete process.env.AUTO_DOC_ARTIFACT_ROOT;
  delete process.env.AUTO_DOC_STATE_FILE;
});

describe("constrain-artifact-output-paths", () => {
  it("rejects traversal and absolute escape paths before any file is written", async () => {
    const { root } = await setupProject();
    const { registerExportManualPdfTool } = await import("../../src/tools/export-manual-pdf.js");
    const pdf = await handlerFor(registerExportManualPdfTool, "export_manual_pdf");
    const outside = resolve(root, "escape.pdf");

    await expect(pdf({ projectId: "project_1", releaseVersion: "1.0.0", outputPath: "../escape.pdf" })).rejects.toSatisfy((error) => {
      expect(parseError(error).error.code).toBe("ARTIFACT_PATH_OUTSIDE_ROOT");
      return true;
    });
    await expect(pdf({ projectId: "project_1", releaseVersion: "1.0.0", outputPath: outside })).rejects.toSatisfy((error) => {
      expect(parseError(error).error.code).toBe("ARTIFACT_PATH_OUTSIDE_ROOT");
      return true;
    });
    expect(await exists(outside)).toBe(false);
  });

  it("allows all artifact writers to create real files inside AUTO_DOC_ARTIFACT_ROOT", async () => {
    const { artifactRoot } = await setupProject();
    const { registerExportManualPdfTool } = await import("../../src/tools/export-manual-pdf.js");
    const { registerSyncManualToLocalDocsTool } = await import("../../src/tools/sync-manual-to-local-docs.js");
    const { registerExportHelpCenterContentTool } = await import("../../src/tools/export-help-center-content.js");
    const pdf = await handlerFor(registerExportManualPdfTool, "export_manual_pdf");
    const sync = await handlerFor(registerSyncManualToLocalDocsTool, "sync_manual_to_local_docs");
    const help = await handlerFor(registerExportHelpCenterContentTool, "export_help_center_content");

    const pdfResult = JSON.parse((await pdf({ projectId: "project_1", releaseVersion: "1.0.0", outputPath: "manuals/release.pdf" })).content[0].text) as { outputPath: string };
    const syncResult = JSON.parse((await sync({ projectId: "project_1", releaseVersion: "1.0.0", outputPath: "docs/MANUAL.md" })).content[0].text) as { outputPath: string };
    const helpResult = JSON.parse((await help({ projectId: "project_1", releaseVersion: "1.0.0", outputPath: "help/help.json" })).content[0].text) as { outputPath: string };
    const screenshotPath = await captureScreenshot("https://example.com", "screens/home.png");

    for (const outputPath of [pdfResult.outputPath, syncResult.outputPath, helpResult.outputPath, screenshotPath]) {
      expect(isAbsolute(outputPath)).toBe(true);
      expect(outputPath.startsWith(artifactRoot)).toBe(true);
      expect(await exists(outputPath)).toBe(true);
    }
    expect(await readFile(syncResult.outputPath, "utf8")).toContain("Billing Export");
    expect(await readFile(helpResult.outputPath, "utf8")).toContain("Billing Export");
  });

  it("routes each production write site through the shared artifact path chokepoint", async () => {
    const { readFile: readSource } = await import("node:fs/promises");
    for (const file of [
      "src/tools/export-manual-pdf.ts",
      "src/tools/sync-manual-to-local-docs.ts",
      "src/tools/export-help-center-content.ts",
      "src/lib/screenshots.ts",
    ]) {
      expect(await readSource(file, "utf8")).toContain("resolveArtifactPath");
    }
  });
});
