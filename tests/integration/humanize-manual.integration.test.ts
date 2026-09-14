import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { registerHumanizeManualTool } from "../../src/tools/humanize-manual.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

function parseTool<T>(result: ToolResult): T {
  return JSON.parse(result.content[0]?.text ?? "{}") as T;
}

describe("humanize_manual", () => {
  it("humanizes standalone markdown and manual entries as an MCP tool", async () => {
    const server = new FakeServer();
    registerHumanizeManualTool(server as unknown as McpServer);
    const handler = server.handlers.get("humanize_manual");
    expect(handler).toBeDefined();

    const result = parseTool<{
      markdown: string;
      markdownChanged: boolean;
      entries: Array<{ title: string; body: string }>;
      changedEntryCount: number;
      metrics: { aiPhraseReplacements: number; codeLineChanges: number };
    }>(
      await handler!({
        markdown: "In this guide, utilize the setup flow.",
        entries: [
          {
            title: "Setup",
            body: "This guide explains how to utilize setup.\n\n```bash\nbash npm run build\n```",
            audience: "User",
            status: "Published",
          },
        ],
      }),
    );

    expect(result.markdownChanged).toBe(true);
    expect(result.markdown).toContain("use the setup flow");
    expect(result.entries[0].body).toContain("use setup");
    expect(result.entries[0].body).toContain("```bash\nnpm run build\n```");
    expect(result.changedEntryCount).toBe(1);
    expect(result.metrics.aiPhraseReplacements).toBeGreaterThan(0);
    expect(result.metrics.codeLineChanges).toBeGreaterThan(0);
  });

  it("humanizes inline content with the dedicated humanize_content tool", async () => {
    const server = new FakeServer();
    registerHumanizeManualTool(server as unknown as McpServer);
    const handler = server.handlers.get("humanize_content");
    expect(handler).toBeDefined();

    const result = parseTool<{
      humanized: string;
      changed: boolean;
      metrics: { aiPhraseReplacements: number; removedCodeCommentCount: number };
    }>(
      await handler!({
        content: [
          "Great question! In this section, we will explore the powerful auth setup.",
          "",
          "```python",
          "# Get the database URL from environment",
          "db_url = os.environ.get('DATABASE_URL')",
          "```",
        ].join("\n"),
        strictnessLevel: 3,
      }),
    );

    expect(result.changed).toBe(true);
    expect(result.humanized).toContain("auth setup");
    expect(result.humanized).not.toMatch(/Great question|In this section|powerful|Get the database URL/i);
    expect(result.humanized).toContain("db_url = os.environ.get('DATABASE_URL')");
    expect(result.metrics.aiPhraseReplacements).toBeGreaterThan(0);
    expect(result.metrics.removedCodeCommentCount).toBe(1);
  });
});
