import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { simpleGit } from "simple-git";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { redactSecrets } from "../lib/redaction.js";

function truncate(input: string, max = 8000): string {
  return input.length <= max ? input : `${input.slice(0, max)}\n\n[TRUNCATED]`;
}

export function registerGetGitDiffSummaryTool(server: McpServer) {
  server.tool(
    "get_git_diff_summary",
    "Reads recent local Git changes and returns a redacted summary.",
    {
      repoPath: z.string(),
      mode: z.enum(["staged", "last_commit", "working_tree"]),
      traceId: z.string().optional(),
    },
    async ({ repoPath, mode, traceId: incomingTraceId }) => {
      const traceId = resolveTraceId(incomingTraceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "get_git_diff_summary",
        stage: "start",
        traceId,
        message: "Collecting git diff summary",
        data: { repoPath, mode },
      });

      try {
        const git = simpleGit(repoPath);
        const raw =
          mode === "last_commit"
            ? await git.show(["--stat", "--summary", "HEAD"])
            : mode === "staged"
              ? await git.diff(["--cached"])
              : await git.diff();

        const redacted = truncate(redactSecrets(raw));

        logToolEvent({
          level: "info",
          tool: "get_git_diff_summary",
          stage: "success",
          traceId,
          message: "Collected git diff summary",
          data: { mode, summaryLength: redacted.length, durationMs: Date.now() - startedAt },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ traceId, mode, summary: redacted }, null, 2),
            },
          ],
        };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "get_git_diff_summary",
          stage: "failure",
          traceId,
          message: "Failed to collect git diff summary",
          data: { repoPath, mode, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "get_git_diff_summary",
          traceId,
          error,
          defaultCode: "GIT_DIFF_SUMMARY_FAILED",
        });
      }
    },
  );
}
