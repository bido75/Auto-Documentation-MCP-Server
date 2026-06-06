import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPublishPrCommentTool } from "../../src/tools/publish-pr-comment.js";

vi.mock("../../src/tools/generate-pr-comment-preview.js", () => ({
  registerGeneratePrCommentPreviewTool: (server: {
    tool: (
      name: string,
      description: string,
      schema: unknown,
      handler: (input: {
        projectId: string;
        prUrl: string;
        audience: "user" | "admin" | "both";
        maxEntries: number;
        traceId?: string;
      }) => Promise<{ content: Array<{ type: string; text: string }> }>,
    ) => void;
  }) => {
    server.tool(
      "generate_pr_comment_preview",
      "mock",
      {},
      async ({ projectId, prUrl, audience, maxEntries, traceId }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                traceId,
                projectId,
                prUrl,
                audience,
                maxEntries,
                entryCount: 2,
                markdownPreview: "## Auto-Doc Preview\n\nUpdated preview content",
              },
              null,
              2,
            ),
          },
        ],
      }),
    );
  },
}));

type ToolResult = { content: Array<{ type: string; text: string }> };

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<ToolResult>>();

  tool(name: string, _description: string, _schema: unknown, handler: (input: unknown) => Promise<ToolResult>): void {
    this.handlers.set(name, handler);
  }
}

function parseToolResult<T>(value: ToolResult): T {
  return JSON.parse(value.content[0]?.text ?? "{}") as T;
}

function createResponse<T>(body: T, ok = true, status = 200, statusText = "OK") {
  return {
    ok,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("publish_pr_comment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_API_BASE_URL;
  });

  it("updates an existing marker-owned comment instead of creating a new one", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.GITHUB_API_BASE_URL = "https://api.github.com";

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createResponse([
          {
            id: 321,
            body: "<!-- auto-doc-pr-comment project=proj_123 -->\nOld preview",
            html_url: "https://github.com/octo/repo/pull/17#issuecomment-321",
          },
          {
            id: 999,
            body: "unrelated comment",
          },
        ]),
      )
      .mockResolvedValueOnce(
        createResponse({
          id: 321,
          body: "<!-- auto-doc-pr-comment project=proj_123 -->\n## Auto-Doc Preview",
          html_url: "https://github.com/octo/repo/pull/17#issuecomment-321",
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const server = new FakeServer();
    registerPublishPrCommentTool(server as never);

    const handler = server.handlers.get("publish_pr_comment");
    expect(handler).toBeDefined();

    const result = parseToolResult<{
      action: "created" | "updated";
      commentId: number;
      commentUrl: string | null;
      entryCount: number;
    }>(
      await handler!({
        projectId: "proj_123",
        prUrl: "https://github.com/octo/repo/pull/17",
        audience: "both",
        maxEntries: 8,
        dryRun: false,
        traceId: "trace-pr-update",
      }),
    );

    expect(result.action).toBe("updated");
    expect(result.commentId).toBe(321);
    expect(result.commentUrl).toContain("issuecomment-321");
    expect(result.entryCount).toBe(2);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const listCall = fetchMock.mock.calls[0] as [string, { method: string }];
    expect(listCall[0]).toContain("/repos/octo/repo/issues/17/comments?per_page=100");
    expect(listCall[1].method).toBe("GET");

    const updateCall = fetchMock.mock.calls[1] as [string, { method: string; body: string }];
    expect(updateCall[0]).toContain("/repos/octo/repo/issues/comments/321");
    expect(updateCall[1].method).toBe("PATCH");

    const updateBody = JSON.parse(updateCall[1].body) as { body: string };
    expect(updateBody.body).toContain("<!-- auto-doc-pr-comment project=proj_123 -->");
    expect(updateBody.body).toContain("## Auto-Doc Preview");
    expect(updateBody.body).toContain("Updated preview content");
  });
});
