/**
 * Acceptance: Visual feature criterion 3 - manual-entry figures + contract preservation
 * Notion image blocks, idempotency, and BYTE-IDENTICAL behavior for figure-less entries.
 * DO NOT DELETE/SKIP.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { createManualEntry } from "../../src/notion/manual-entry.js";

const testContext = vi.hoisted(() => ({
  notion: null as ReturnType<typeof createFakeNotion> | null,
  store: null as StateStore | null,
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => {
    if (!testContext.notion) {
      throw new Error("Test Notion client not initialized");
    }
    return testContext.notion;
  },
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

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;
type FakeBlock = Record<string, unknown>;
type FakePage = {
  id: string;
  url: string;
  parent: { database_id: string };
  properties: Record<string, unknown>;
  children: FakeBlock[];
};

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

function titleText(property: unknown): string {
  return (property as { title?: Array<{ text?: { content?: string } }> } | undefined)?.title?.[0]?.text?.content ?? "";
}

function richText(property: unknown): string {
  return (property as { rich_text?: Array<{ text?: { content?: string } }> } | undefined)?.rich_text?.[0]?.text?.content ?? "";
}

function relationIds(property: unknown): string[] {
  return ((property as { relation?: Array<{ id?: string }> } | undefined)?.relation ?? [])
    .map((item) => item.id ?? "")
    .filter(Boolean);
}

function matches(page: FakePage, filter: Record<string, unknown>): boolean {
  if (Array.isArray(filter.and)) {
    return filter.and.every((clause) => matches(page, clause as Record<string, unknown>));
  }
  const property = typeof filter.property === "string" ? page.properties[filter.property] : undefined;
  if (filter.title) {
    return titleText(property) === (filter.title as { equals?: string }).equals;
  }
  if (filter.rich_text) {
    return richText(property) === (filter.rich_text as { equals?: string }).equals;
  }
  if (filter.relation) {
    const expected = (filter.relation as { contains?: string }).contains;
    return typeof expected === "string" && relationIds(property).includes(expected);
  }
  return false;
}

function createFakeNotion() {
  let pageCounter = 0;
  const pages = new Map<string, FakePage>();
  const api = {
    users: { me: vi.fn(async () => ({ id: "user_1" })) },
    databases: {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({ id: database_id })),
      query: vi.fn(async (input: { database_id: string; filter?: Record<string, unknown>; page_size?: number }) => ({
        results: [...pages.values()]
          .filter((page) => page.parent.database_id === input.database_id)
          .filter((page) => (input.filter ? matches(page, input.filter) : true))
          .slice(0, input.page_size ?? Number.MAX_SAFE_INTEGER)
          .map((page) => ({ id: page.id, url: page.url, properties: page.properties })),
      })),
    },
    pages: {
      create: vi.fn(async (input: { parent: { database_id: string }; properties: Record<string, unknown>; children?: FakeBlock[] }) => {
        pageCounter += 1;
        const page: FakePage = {
          id: `page_${pageCounter}`,
          url: `https://notion.local/page_${pageCounter}`,
          parent: input.parent,
          properties: input.properties,
          children: input.children ?? [],
        };
        pages.set(page.id, page);
        return { id: page.id, url: page.url };
      }),
      update: vi.fn(async (input: { page_id: string; properties: Record<string, unknown> }) => {
        const page = pages.get(input.page_id);
        if (!page) {
          throw new Error(`Missing page ${input.page_id}`);
        }
        page.properties = { ...page.properties, ...input.properties };
        return { id: page.id, url: page.url };
      }),
    },
    _pages: pages,
  };
  return api;
}

async function setupProject() {
  const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-manual-figures-"));
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
}

function parseToolResult<T>(value: ToolResult): T {
  return JSON.parse(value.content[0].text) as T;
}

async function getUpsert() {
  const server = new FakeServer();
  const { registerUpsertFeatureDocumentationTool } = await import("../../src/tools/upsert-feature-documentation.js");
  registerUpsertFeatureDocumentationTool(server as unknown as McpServer);
  const handler = server.handlers.get("upsert_feature_documentation");
  expect(handler).toBeDefined();
  return handler!;
}

async function upsertWithFigure(upsert: ToolHandler) {
  return parseToolResult<{ manualEntries: Array<{ pageId: string }> }>(
    await upsert({
      projectId: "project_1",
      featureKey: "billing-export",
      featureName: "Billing Export",
      audiences: ["User"],
      manualEntries: [
        {
          entryType: "User Guide",
          title: "Export invoices",
          userGuide: "Open Billing Settings and click Export.",
          adminGuide: "",
          figures: [
            {
              url: "https://cdn.example.test/billing-export.png",
              caption: "Billing export button highlighted",
              altText: "Billing Settings screen with Export button",
            },
          ],
        },
      ],
      evidenceEventIds: [],
      confidenceScore: 95,
      confidenceReasons: ["user-facing workflow"],
      publishingMode: "balanced",
      autoPublishThreshold: 60,
    }),
  );
}

beforeEach(() => {
  testContext.notion = null;
  testContext.store = null;
});

describe("manual-entry-figures", () => {
  it("upserting a feature WITH figures yields a Notion manual entry containing real image blocks + captions", async () => {
    await setupProject();
    const upsert = await getUpsert();

    const result = await upsertWithFigure(upsert);
    const page = testContext.notion!._pages.get(result.manualEntries[0].pageId);

    expect(page?.children).toContainEqual({
      object: "block",
      type: "image",
      image: {
        type: "external",
        external: { url: "https://cdn.example.test/billing-export.png" },
        caption: [{ type: "text", text: { content: "Billing export button highlighted" } }],
      },
    });
  });

  it("re-running the upsert is idempotent (no duplicate figures)", async () => {
    await setupProject();
    const upsert = await getUpsert();

    const first = await upsertWithFigure(upsert);
    const second = await upsertWithFigure(upsert);
    const manualPages = [...testContext.notion!._pages.values()].filter((page) => page.parent.database_id === "manual_db");

    expect(second.manualEntries[0].pageId).toBe(first.manualEntries[0].pageId);
    expect(manualPages).toHaveLength(1);
    expect(manualPages[0].children.filter((block) => block.type === "image")).toHaveLength(1);
  });

  it("upserting a feature with NO figures is byte-identical to pre-feature behavior (contract unchanged)", async () => {
    const notion = createFakeNotion();

    await createManualEntry({
      notion,
      databaseId: "manual_db",
      draft: {
        entryTitle: "Export invoices",
        entryType: "User Guide",
        audience: "User",
        body: "Open Billing Settings and click Export.",
      },
      status: "Published",
      decision: "Agent Published",
      confidenceScore: 95,
    });

    const page = [...notion._pages.values()][0];
    expect(page.children).toEqual([
      {
        object: "block",
        type: "heading_2",
        heading_2: { rich_text: [{ type: "text", text: { content: "User Guide" } }] },
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: "Open Billing Settings and click Export." } }] },
      },
      { object: "block", type: "divider", divider: {} },
    ]);
  });

  it("the figures field is optional and absent-by-default in the manual-entry model", async () => {
    const notion = createFakeNotion();

    await expect(
      createManualEntry({
        notion,
        databaseId: "manual_db",
        draft: {
          entryTitle: "Export invoices",
          entryType: "User Guide",
          audience: "User",
          body: "Open Billing Settings and click Export.",
        },
        status: "Published",
        decision: "Agent Published",
        confidenceScore: 95,
      }),
    ).resolves.toMatchObject({ pageId: "page_1" });
  });
});
