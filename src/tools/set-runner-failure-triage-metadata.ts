import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { getStateStore } from "../lib/state-store.js";

export function registerSetRunnerFailureTriageMetadataTool(server: McpServer) {
  server.tool(
    "set_runner_failure_triage_metadata",
    "Sets or clears persisted runner failure triage metadata for a project and repository target.",
    {
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      action: z.enum(["set", "clear"]).default("set"),
      acknowledge: z.boolean().default(false),
      acknowledgedAt: z.string().datetime().optional(),
      acknowledgedBy: z.string().min(1).optional(),
      note: z.string().min(1).optional(),
      cooldownUntil: z.string().datetime().optional(),
      traceId: z.string().optional(),
    },
    async ({
      projectId,
      repoPath,
      action,
      acknowledge,
      acknowledgedAt,
      acknowledgedBy,
      note,
      cooldownUntil,
      traceId: incomingTraceId,
    }) => {
      const traceId = resolveTraceId(incomingTraceId);
      const startedAt = Date.now();

      logToolEvent({
        level: "info",
        tool: "set_runner_failure_triage_metadata",
        stage: "start",
        traceId,
        message: "Updating runner failure triage metadata",
        data: {
          projectId,
          repoPath,
          action,
          acknowledge,
          cooldownUntil: cooldownUntil ?? null,
        },
      });

      try {
        const store = getStateStore();

        if (action === "clear") {
          await store.clearRunnerFailureTriageMetadata(projectId, repoPath);

          logToolEvent({
            level: "info",
            tool: "set_runner_failure_triage_metadata",
            stage: "success",
            traceId,
            message: "Cleared runner failure triage metadata",
            data: {
              projectId,
              repoPath,
              durationMs: Date.now() - startedAt,
            },
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    traceId,
                    projectId,
                    repoPath,
                    action,
                    triageMetadata: null,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const metadata = {
          ...(acknowledge ? { acknowledgedAt: acknowledgedAt ?? new Date().toISOString() } : {}),
          ...(acknowledgedBy ? { acknowledgedBy } : {}),
          ...(note ? { note } : {}),
          ...(cooldownUntil ? { cooldownUntil } : {}),
        };

        if (Object.keys(metadata).length === 0) {
          throw new Error("set action requires acknowledge=true, acknowledgedBy, note, or cooldownUntil.");
        }

        await store.setRunnerFailureTriageMetadata(projectId, repoPath, metadata);
        const triageMetadata = await store.getRunnerFailureTriageMetadata(projectId, repoPath);

        logToolEvent({
          level: "info",
          tool: "set_runner_failure_triage_metadata",
          stage: "success",
          traceId,
          message: "Updated runner failure triage metadata",
          data: {
            projectId,
            repoPath,
            action,
            acknowledged: Boolean(triageMetadata?.acknowledgedAt),
            cooldownUntil: triageMetadata?.cooldownUntil ?? null,
            durationMs: Date.now() - startedAt,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  traceId,
                  projectId,
                  repoPath,
                  action,
                  triageMetadata,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "set_runner_failure_triage_metadata",
          stage: "failure",
          traceId,
          message: "Failed to update runner failure triage metadata",
          data: {
            projectId,
            repoPath,
            action,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
          },
        });

        throwAsMcpToolError({
          tool: "set_runner_failure_triage_metadata",
          traceId,
          error,
          defaultCode: "SET_RUNNER_FAILURE_TRIAGE_METADATA_FAILED",
        });
      }
    },
  );
}