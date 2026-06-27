/**
 * Acceptance: criterion 3 - assembly yields ONE coherent document per audience.
 * DO NOT DELETE/SKIP.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";

const testContext = vi.hoisted(() => ({
  notion: null as ReturnType<typeof createFakeNotion> | null,
  store: null as StateStore | null,
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

type Block = Record<string, unknown>;
type Page = { id: string; parent: Record<string, string>; properties: Record<string, unknown>; children: Block[]; url: string };

function richText(content: string) {
  return [{ type: "text", text: { content }, plain_text: content }];
}

function getTitle(properties: Record<string, unknown>, key: string): string {
  return (properties[key] as { title?: Array<{ text?: { content?: string } }> } | undefined)?.title?.[0]?.text?.content ?? "";
}

function getSelect(properties: Record<string, unknown>, key: string): string {
  return (properties[key] as { select?: { name?: string } } | undefined)?.select?.name ?? "";
}

function getStatus(properties: Record<string, unknown>, key: string): string {
  return (properties[key] as { status?: { name?: string } } | undefined)?.status?.name ?? "";
}

function createManualPage(input: { id: string; title: string; audience: "User" | "Admin"; body: string }): Page {
  return {
    id: input.id,
    url: `https://notion.local/${input.id}`,
    parent: { database_id: "manual_db" },
    properties: {
      "Entry Title": { title: [{ text: { content: input.title } }] },
      "Entry Type": { select: { name: `${input.audience} Guide` } },
      Audience: { select: { name: input.audience } },
      Status: { status: { name: "Published" } },
      Project: { relation: [{ id: "project_page_1" }] },
    },
    children: input.body.split(/\n\n+/).map((part) => ({ type: "paragraph", paragraph: { rich_text: richText(part) } })),
  };
}

function createFakeNotion() {
  let counter = 0;
  const pages = new Map<string, Page>();
  return {
    users: { me: vi.fn(async () => ({ id: "user_1" })) },
    databases: {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({ id: database_id })),
      query: vi.fn(async ({ database_id }: { database_id: string }) => ({
        results: [...pages.values()]
          .filter((page) => page.parent.database_id === database_id)
          .map((page) => ({ id: page.id, url: page.url, properties: page.properties })),
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
        list: vi.fn(async ({ block_id }: { block_id: string }) => ({ results: pages.get(block_id)?.children ?? [] })),
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

class FakeServer {
  readonly handlers = new Map<string, (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>>();
  tool(name: string, _description: string, _schema: unknown, handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>) {
    this.handlers.set(name, handler);
  }
}

function textOf(page: Page): string {
  return page.children
    .map((block) => {
      const candidate = block as { heading_1?: { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> }; heading_2?: { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> }; paragraph?: { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> } };
      return [...(candidate.heading_1?.rich_text ?? []), ...(candidate.heading_2?.rich_text ?? []), ...(candidate.paragraph?.rich_text ?? [])]
        .map((part) => part.plain_text ?? part.text?.content ?? "")
        .join("");
    })
    .filter(Boolean)
    .join("\n");
}

async function setup() {
  const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-assembly-"));
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
  testContext.notion._addPage(createManualPage({ id: "user_1", title: "Install and use the MCP server", audience: "User", body: "## Overview\nUse Auto-Doc from an MCP client.\n\n## Step-by-step setup\n1. Run `npm install`.\n2. Run `npm run build`.\n\nExpected result: the server starts." }));
  testContext.notion._addPage(createManualPage({ id: "user_2", title: "Export the manual", audience: "User", body: "## How to use it\n1. Capture evidence.\n2. Export markdown.\n\n## Troubleshooting\nIf export fails, check Notion access." }));
  testContext.notion._addPage(createManualPage({ id: "admin_1", title: "Deploy the bridge", audience: "Admin", body: "## Requirements\nSet NOTION_TOKEN and STATE_ENCRYPTION_KEY.\n\n## Operations setup\n1. Start `node build/src/cli/index.js bridge`.\n2. Check `GET /health`.\n\nExpected result: health is OK." }));
  testContext.notion._addPage(createManualPage({ id: "admin_2", title: "Operate the runner", audience: "Admin", body: "## Troubleshooting\nIf jobs stop, inspect runner failure triage.\n\n## Configuration reference\nAUTO_DOC_RUNNER_PROJECT_ID" }));
}

async function assemble() {
  const server = new FakeServer();
  const { registerAssembleManualTool } = await import("../../src/tools/assemble-manual.js");
  registerAssembleManualTool(server as unknown as McpServer);
  const result = await server.handlers.get("assemble_manual")!({ projectId: "project_1" });
  return JSON.parse(result.content[0].text) as { manuals: { user: { pageId: string }; admin: { pageId: string } } };
}

beforeEach(() => {
  testContext.notion = null;
  testContext.store = null;
});

describe("manual-assembly", () => {
  it("assemble_manual produces exactly ONE User Manual document", async () => {
    await setup();
    const result = await assemble();
    const userPages = [...testContext.notion!._pages.values()].filter((page) => getTitle(page.properties, "title") === "User Manual");
    expect(result.manuals.user.pageId).toMatch(/^assembled_/);
    expect(userPages).toHaveLength(1);
  });

  it("assemble_manual produces exactly ONE Admin Manual document", async () => {
    await setup();
    const result = await assemble();
    const adminPages = [...testContext.notion!._pages.values()].filter((page) => getTitle(page.properties, "title") === "Admin Manual");
    expect(result.manuals.admin.pageId).toMatch(/^assembled_/);
    expect(adminPages).toHaveLength(1);
  });

  it("each manual has a table of contents", async () => {
    await setup();
    const result = await assemble();
    const userText = textOf(testContext.notion!._pages.get(result.manuals.user.pageId)!);
    const adminText = textOf(testContext.notion!._pages.get(result.manuals.admin.pageId)!);
    expect(userText).toContain("Table of contents");
    expect(adminText).toContain("Table of contents");
  });

  it("keeps authored admin feature content in logical order without global section buckets", async () => {
    await setup();
    const result = await assemble();
    const adminText = textOf(testContext.notion!._pages.get(result.manuals.admin.pageId)!);
    expect(adminText).not.toContain("Step-by-step setup");
    expect(adminText.indexOf("Deploy the bridge")).toBeLessThan(adminText.indexOf("Requirements"));
    expect(adminText.indexOf("Requirements")).toBeLessThan(adminText.indexOf("Operations setup"));
    expect(adminText.indexOf("Operations setup")).toBeLessThan(adminText.indexOf("Expected result"));
  });

  it("each manual is composed from MULTIPLE feature sections into one readable document", async () => {
    await setup();
    const result = await assemble();
    const userText = textOf(testContext.notion!._pages.get(result.manuals.user.pageId)!);
    expect(userText).toContain("Install and use the MCP server");
    expect(userText).toContain("Export the manual");
  });

  it("the deliverable is one document per audience, not scattered database rows", async () => {
    await setup();
    await assemble();
    const assembledPages = [...testContext.notion!._pages.values()].filter((page) => "page_id" in page.parent);
    expect(assembledPages.map((page) => getTitle(page.properties, "title")).sort()).toEqual(["Admin Manual", "User Manual"]);
    expect([...testContext.notion!._pages.values()].filter((page) => page.parent.database_id === "manual_db")).toHaveLength(4);
  });
});
