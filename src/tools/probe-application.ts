import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { probeApplication } from "../lib/application-probe.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";

export function registerProbeApplicationTool(server: McpServer): void {
  server.tool(
    "probe_application",
    "Performs a read-only static scan of an existing codebase and returns a retrospective feature inventory.",
    {
      repoPath: z.string(),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "probe_application",
        stage: "start",
        traceId,
        message: "Probing application codebase",
        data: { repoPath: input.repoPath },
      });

      try {
        const inventory = await probeApplication({ repoPath: input.repoPath });
        logToolEvent({
          level: "info",
          tool: "probe_application",
          stage: "success",
          traceId,
          message: "Completed application probe",
          data: {
            repoPath: inventory.repoPath,
            fileCount: inventory.fileCount,
            featureCount: inventory.features.length,
            durationMs: Date.now() - startedAt,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ traceId, inventory }, null, 2),
            },
          ],
        };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "probe_application",
          stage: "failure",
          traceId,
          message: "Failed to probe application",
          data: { repoPath: input.repoPath, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({ tool: "probe_application", traceId, error, defaultCode: "PROBE_APPLICATION_FAILED" });
      }
    },
  );
}

