import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRunnerHealth } from "../lib/runner-health.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";

export function registerHealthCheckTool(server: McpServer) {
  server.tool(
    "health_check",
    "Returns persisted continuous-runner health, liveness, and recent monitoring alerts.",
    {
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();

      logToolEvent({
        level: "info",
        tool: "health_check",
        stage: "start",
        traceId,
        message: "Reading continuous runner health state",
      });

      try {
        const health = await getRunnerHealth(process.env, new Date(), traceId);

        logToolEvent({
          level: health.status === "healthy" ? "info" : "warn",
          tool: "health_check",
          stage: "success",
          traceId,
          message: "Read continuous runner health state",
          data: {
            status: health.status,
            stale: health.stale,
            recentAlertCount: health.recentAlerts.length,
            durationMs: Date.now() - startedAt,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(health, null, 2),
            },
          ],
        };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "health_check",
          stage: "failure",
          traceId,
          message: "Failed to read continuous runner health state",
          data: { error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "health_check",
          traceId,
          error,
          defaultCode: "HEALTH_CHECK_FAILED",
        });
      }
    },
  );
}
