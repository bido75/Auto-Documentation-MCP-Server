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

describe("publish_pr_comment", () => {
  it("updates existing auto-doc comment when marker already exists", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-pr-comment-"));
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

    testContext.notion = {
      users: {
        me: vi.fn(async () => ({ object: "user" })),
      },
      databases: {
        retrieve: vi.fn(async () => ({ object: "database" })),
        query: vi.fn(async () => ({
          results: [
            {
              id: "entry_1",
              properties: {
                "Entry Title": { title: [{ text: { content: "Export invoices from Billing" } }] },
                "Entry Type": { select: { name: "User Guide" } },
                Audience: { select: { name: "User" } },
                Status: { status: { name: "Published" } },
                "Confidence Score": { number: 95 },
                "Source PR": { url: "https://github.com/acme/app/pull/42" },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        })),
      },
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => [{ id: 1001, body: "<!-- auto-doc-pr-comment project=proj_1 --> old comment" }],
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ id: 1001, html_url: "https://github.com/acme/app/pull/42#issuecomment-1001" }),
      });

    vi.stubGlobal("fetch", fetchMock);
    process.env.GITHUB_TOKEN = "ghs_test_token";

    const server = new FakeServer();
    const { registerPublishPrCommentTool } = await import("../../src/tools/publish-pr-comment.js");
    registerPublishPrCommentTool(server as never);

    const publish = server.handlers.get("publish_pr_comment");
    expect(publish).toBeDefined();

    const result = parseToolResult<{
      projectId: string;
      prUrl: string;
      action: string;
      commentId: number;
      commentUrl: string | null;
      entryCount: number;
    }>(
      await publish!({
        projectId: "proj_1",
        prUrl: "https://github.com/acme/app/pull/42",
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.action).toBe("updated");
    expect(result.commentId).toBe(1001);
    expect(result.commentUrl).toContain("issuecomment-1001");
    expect(result.entryCount).toBe(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/repos/acme/app/issues/comments/1001");
  });
});
