/**
 * Acceptance: Stage C - export and package use coherent assembled manuals.
 * DO NOT DELETE/SKIP.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";

const testContext = vi.hoisted(() => ({
  notion: null as ReturnType<typeof createFakeNotion> | null,
  store: null as StateStore | null,
  pdfCalls: [] as Array<{ markdown: string; outputPath: string; title: string }>,
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
    testContext.pdfCalls.push(input);
    return input.outputPath;
  }),
}));

type Block = Record<string, unknown>;
type Page = { id: string; parent: Record<string, string>; properties: Record<string, unknown>; children: Block[]; url: string };
type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();
  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

function richText(content: string) {
  return [{ type: "text", text: { content }, plain_text: content }];
}

function titleProperty(value: string) {
  return { title: [{ text: { content: value }, plain_text: value }] };
}

function selectProperty(value: string) {
  return { select: { name: value } };
}

function statusProperty(value: string) {
  return { status: { name: value } };
}

function relationProperty(...ids: string[]) {
  return { relation: ids.map((id) => ({ id })) };
}

function paragraph(text: string): Block {
  return { type: "paragraph", paragraph: { rich_text: richText(text) } };
}

function textFromTitle(property: unknown): string | undefined {
  return (property as { title?: Array<{ text?: { content?: string } }> } | undefined)?.title?.[0]?.text?.content;
}

function textFromStatus(property: unknown): string | undefined {
  return (property as { status?: { name?: string } } | undefined)?.status?.name;
}

function relationIds(property: unknown): string[] {
  return ((property as { relation?: Array<{ id?: string }> } | undefined)?.relation ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string");
}

function clauseMatches(page: Page, clause: Record<string, unknown>): boolean {
  if ("and" in clause && Array.isArray(clause.and)) {
    return clause.and.every((item) => clauseMatches(page, item as Record<string, unknown>));
  }
  const propertyName = clause.property;
  if (typeof propertyName !== "string") return true;
  const property = page.properties[propertyName];
  if ("relation" in clause) {
    const expected = (clause.relation as { contains?: string }).contains;
    return typeof expected !== "string" || relationIds(property).includes(expected);
  }
  if ("title" in clause) {
    const expected = (clause.title as { equals?: string }).equals;
    return typeof expected !== "string" || textFromTitle(property) === expected;
  }
  if ("status" in clause) {
    const expected = (clause.status as { equals?: string }).equals;
    return typeof expected !== "string" || textFromStatus(property) === expected;
  }
  return true;
}

function createManualPage(input: { id: string; title: string; audience: "User" | "Admin"; body: string }): Page {
  return {
    id: input.id,
    url: `https://notion.local/${input.id}`,
    parent: { database_id: "manual_db" },
    properties: {
      "Entry Title": titleProperty(input.title),
      "Entry Type": selectProperty(`${input.audience} Guide`),
      Audience: selectProperty(input.audience),
      Status: statusProperty("Published"),
      Project: relationProperty("project_page_1"),
    },
    children: input.body.split(/\n\n+/).map(paragraph),
  };
}

function createFakeNotion() {
  let counter = 0;
  const pages = new Map<string, Page>();
  return {
    users: { me: vi.fn(async () => ({ id: "user_1" })) },
    databases: {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({ id: database_id })),
      query: vi.fn(async (input: { database_id: string; filter?: Record<string, unknown>; page_size?: number }) => ({
        results: [...pages.values()]
          .filter((page) => page.parent.database_id === input.database_id)
          .filter((page) => (input.filter ? clauseMatches(page, input.filter) : true))
          .slice(0, input.page_size ?? pages.size)
          .map((page) => ({ id: page.id, url: page.url, properties: page.properties })),
        has_more: false,
        next_cursor: null,
      })),
    },
    pages: {
      create: vi.fn(async (input: { parent: Record<string, string>; properties: Record<string, unknown>; children?: Block[] }) => {
        counter += 1;
        const page: Page = {
          id: `assembled_${counter}`,
          url: `https://notion.local/assembled_${counter}`,
          parent: input.parent,
          properties: input.properties,
          children: input.children ?? [],
        };
        pages.set(page.id, page);
        return { id: page.id, url: page.url };
      }),
      update: vi.fn(async (input: { page_id: string; properties: Record<string, unknown> }) => {
        const page = pages.get(input.page_id);
        if (!page) throw new Error(`Missing page ${input.page_id}`);
        page.properties = { ...page.properties, ...input.properties };
        return { id: page.id, url: page.url };
      }),
    },
    blocks: {
      children: {
        list: vi.fn(async ({ block_id }: { block_id: string }) => ({ results: pages.get(block_id)?.children ?? [], has_more: false, next_cursor: null })),
        append: vi.fn(async ({ block_id, children }: { block_id: string; children: Block[] }) => {
          const page = pages.get(block_id);
          if (!page) throw new Error(`Missing page ${block_id}`);
          page.children = children;
          return { results: children };
        }),
      },
    },
    _pages: pages,
    _addPage: (page: Page) => pages.set(page.id, page),
  };
}

function parseTool<T>(result: ToolResult): T {
  return JSON.parse(result.content[0].text) as T;
}

async function handlerFor(register: (server: McpServer) => void, name: string): Promise<ToolHandler> {
  const server = new FakeServer();
  register(server as unknown as McpServer);
  const handler = server.handlers.get(name);
  expect(handler).toBeDefined();
  return handler!;
}

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-stage-c-"));
  process.env.AUTO_DOC_ARTIFACT_ROOT = stateDir;
  testContext.store = new StateStore(join(stateDir, "state.json"));
  testContext.notion = createFakeNotion();
  await testContext.store.upsertProject({
    projectId: "project_1",
    projectName: "Auto-Documentation MCP Server",
    parentPageId: "parent_1",
    publishingMode: "Balanced",
    autoPublishThreshold: 60,
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
  testContext.notion._addPage(createManualPage({ id: "user_1", title: "Install and use the MCP server", audience: "User", body: "## Overview\nUse Auto-Doc from an MCP client.\n\n## Step-by-step setup\n1. Run npm install.\n2. Run npm run build." }));
  testContext.notion._addPage(createManualPage({ id: "user_2", title: "Export the manual", audience: "User", body: "## How to use it\n1. Capture evidence.\n2. Export markdown." }));
  testContext.notion._addPage(createManualPage({ id: "admin_1", title: "Deploy the bridge", audience: "Admin", body: "## Requirements\nSet NOTION_TOKEN and STATE_ENCRYPTION_KEY.\n\n## Operations setup\n1. Start the bridge.\n2. Check GET /health." }));
  return { stateDir };
}

async function assemble() {
  const { registerAssembleManualTool } = await import("../../src/tools/assemble-manual.js");
  const handler = await handlerFor(registerAssembleManualTool, "assemble_manual");
  return parseTool<{ manuals: { user: { pageId: string }; admin: { pageId: string } } }>(await handler({ projectId: "project_1" }));
}

beforeEach(() => {
  testContext.notion = null;
  testContext.store = null;
  testContext.pdfCalls = [];
  delete process.env.AUTO_DOC_ARTIFACT_ROOT;
});

describe("assembled export and release output", () => {
  it("export_manual_markdown emits assembled User and Admin manuals instead of scattered entry rows", async () => {
    await setup();
    await assemble();
    const { registerExportManualMarkdownTool } = await import("../../src/tools/export-manual-markdown.js");
    const exportMarkdown = await handlerFor(registerExportManualMarkdownTool, "export_manual_markdown");
    const result = parseTool<{ markdown: string }>(await exportMarkdown({ projectId: "project_1", audience: "both" }));
    expect(result.markdown).toContain("# User Manual");
    expect(result.markdown).toContain("# Admin Manual");
    expect(result.markdown).toContain("Table of contents");
    expect(result.markdown.indexOf("# User Manual")).toBeLessThan(result.markdown.indexOf("# Admin Manual"));
    expect(result.markdown).not.toContain("# Auto-Documentation MCP Server Both Manual");
  });

  it("package_manual markdown packages the assembled manual deliverable, not raw entries", async () => {
    await setup();
    await assemble();
    const { registerPackageManualTool } = await import("../../src/tools/package-manual.js");
    const packageManual = await handlerFor(registerPackageManualTool, "package_manual");
    const result = parseTool<{ output: string; includedEntryCount: number }>(
      await packageManual({ projectId: "project_1", releaseVersion: "1.0.0", audience: "both", format: "markdown" }),
    );
    expect(result.output).toContain("# User Manual");
    expect(result.output).toContain("# Admin Manual");
    expect(result.output).toContain("Deploy the bridge");
    expect(result.output).not.toContain("# Auto-Documentation MCP Server Both Manual - 1.0.0");
    expect(result.includedEntryCount).toBe(3);
  });

  it("export_manual_pdf renders the assembled manual markdown into the PDF generator", async () => {
    const { stateDir } = await setup();
    await assemble();
    const { registerExportManualPdfTool } = await import("../../src/tools/export-manual-pdf.js");
    const exportPdf = await handlerFor(registerExportManualPdfTool, "export_manual_pdf");
    await exportPdf({ projectId: "project_1", releaseVersion: "1.0.0", audience: "both", outputPath: join(stateDir, "manual.pdf") });
    expect(testContext.pdfCalls).toHaveLength(1);
    expect(testContext.pdfCalls[0]?.markdown).toContain("# User Manual");
    expect(testContext.pdfCalls[0]?.markdown).toContain("# Admin Manual");
    expect(testContext.pdfCalls[0]?.markdown).toContain("Table of contents");
    expect(testContext.pdfCalls[0]?.markdown).not.toContain("# Auto-Documentation MCP Server Both Manual - 1.0.0");
  });

  it("sync_manual_to_local_docs writes the assembled manual markdown to disk", async () => {
    const { stateDir } = await setup();
    await assemble();
    const { registerSyncManualToLocalDocsTool } = await import("../../src/tools/sync-manual-to-local-docs.js");
    const sync = await handlerFor(registerSyncManualToLocalDocsTool, "sync_manual_to_local_docs");
    const outputPath = join(stateDir, "MANUAL.md");
    await sync({ projectId: "project_1", releaseVersion: "1.0.0", audience: "both", outputPath });
    const markdown = await readFile(outputPath, "utf8");
    expect(markdown).toContain("# User Manual");
    expect(markdown).toContain("# Admin Manual");
    expect(markdown).toContain("Deploy the bridge");
    expect(markdown).not.toContain("# Auto-Documentation MCP Server Manual Export");
  });
});
