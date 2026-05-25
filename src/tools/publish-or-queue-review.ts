import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { decidePublishingStatus } from "../notion/manual-entry.js";

function normalizePublishingMode(mode: "conservative" | "balanced" | "fully_automatic") {
  if (mode === "conservative") {
    return "Conservative" as const;
  }

  if (mode === "fully_automatic") {
    return "Fully Automatic" as const;
  }

  return "Balanced" as const;
}

export function registerPublishOrQueueReviewTool(server: McpServer) {
  server.tool(
    "publish_or_queue_review",
    "Applies project publishing policy to a documentation candidate.",
    {
      projectId: z.string(),
      featureId: z.string(),
      manualEntryIds: z.array(z.string()),
      confidenceScore: z.number().min(0).max(100),
      publishingMode: z.enum(["conservative", "balanced", "fully_automatic"]),
      autoPublishThreshold: z.number().min(0).max(100).default(90),
      hasContradiction: z.boolean().default(false),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "publish_or_queue_review",
        stage: "start",
        traceId,
        message: "Applying publishing policy",
        data: { projectId: input.projectId, featureId: input.featureId, confidenceScore: input.confidenceScore },
      });

      try {
        const status = decidePublishingStatus({
          mode: normalizePublishingMode(input.publishingMode),
          score: input.confidenceScore,
          threshold: input.autoPublishThreshold,
          hasContradiction: input.hasContradiction,
        });

        logToolEvent({
          level: "info",
          tool: "publish_or_queue_review",
          stage: "success",
          traceId,
          message: "Applied publishing policy",
          data: { finalStatus: status.status, durationMs: Date.now() - startedAt },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  traceId,
                  featureId: input.featureId,
                  manualEntryIds: input.manualEntryIds,
                  finalStatus: status.status,
                  publishingDecision: status.decision,
                  reviewNotes:
                    status.status === "Needs Review"
                      ? "Queued for human review due to score/policy constraints."
                      : "Published automatically by confidence policy.",
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
          tool: "publish_or_queue_review",
          stage: "failure",
          traceId,
          message: "Failed to apply publishing policy",
          data: { error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "publish_or_queue_review",
          traceId,
          error,
          defaultCode: "PUBLISH_POLICY_FAILED",
        });
      }
    },
  );
}
