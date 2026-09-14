import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { registerDiscoverProjectFromNotionTool } from "../../src/tools/discover-project-from-notion.js";

const context = vi.hoisted(() => ({
  store: null as StateStore | null,
  notion: null as unknown,
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => context.notion,
}));

vi.mock("../../src/lib/state-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/state-store.js")>();
  return {
    ...actual,
    getStateStore: () => {
      if (!context.store) throw new Error("test store missing");
      return context.store;
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
  return JSON.parse(value.content[0]!.text) as T;
}

describe("discover_project_from_notion tool", () => {
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-discovery-tool-"));
    context.store = new StateStore(join(dir, "state.json"));
    context.notion = {
      pages: {
        retrieve: async () => ({ id: "page_1", parent: { type: "database_id", database_id: "projects_db" }, properties: {} }),
      },
      databases: {
        retrieve: async ({ database_id }: { database_id: string }) => ({
          id: database_id,
          parent: { type: "page_id", page_id: "parent_1" },
          properties: {},
        }),
        query: async () => ({ results: [] }),
      },
      blocks: { children: { list: async () => ({ results: [] }) } },
    };
  });

  it("registers the explicit discovery entry point and returns a refusal without writing partial state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-discovery-health-"));
    const previousHealth = process.env.AUTO_DOC_HEALTH_FILE;
    const previousFeed = process.env.AUTO_DOC_ALERT_FEED_FILE;
    process.env.AUTO_DOC_HEALTH_FILE = join(dir, "health.json");
    process.env.AUTO_DOC_ALERT_FEED_FILE = join(dir, "alerts.jsonl");

    try {
      const server = new FakeServer();
      registerDiscoverProjectFromNotionTool(server as unknown as McpServer);
      const handler = server.handlers.get("discover_project_from_notion");
      expect(handler).toBeDefined();

      const result = parseToolResult<{ ok: boolean; reasonCode: string }>(
        await handler!({ projectPageId: "page_1", traceId: "tool-refusal" }),
      );

      expect(result).toMatchObject({ ok: false, reasonCode: "missing_database" });
      expect(await context.store!.getProject("page_1")).toBeNull();
      expect(await readFile(process.env.AUTO_DOC_ALERT_FEED_FILE!, "utf8")).toContain("project_discovery_failed");
    } finally {
      if (previousHealth === undefined) delete process.env.AUTO_DOC_HEALTH_FILE;
      else process.env.AUTO_DOC_HEALTH_FILE = previousHealth;
      if (previousFeed === undefined) delete process.env.AUTO_DOC_ALERT_FEED_FILE;
      else process.env.AUTO_DOC_ALERT_FEED_FILE = previousFeed;
    }
  });
});
