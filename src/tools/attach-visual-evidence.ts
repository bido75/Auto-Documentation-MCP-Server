import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { attachVisualEvidence } from "../lib/visual-evidence.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { getStateStore } from "../lib/state-store.js";

export function registerAttachVisualEvidenceTool(server: McpServer) {
  server.tool(
    "attach_visual_evidence",
    "Stores a provided visual artifact under the configured artifact root for use in manuals.",
    {
      projectId: z.string(),
      caption: z.string(),
      sourcePath: z.string().optional(),
      imageBase64: z.string().optional(),
      outputPath: z.string().optional(),
      altText: z.string().optional(),
      evidenceEventId: z.string().optional(),
      featureKey: z.string().optional(),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      logToolEvent({
        level: "info",
        tool: "attach_visual_evidence",
        stage: "start",
        traceId,
        message: "Attaching visual evidence artifact",
        data: { projectId: input.projectId, featureKey: input.featureKey },
      });

      try {
        const evidence = await attachVisualEvidence(input);
        const store = getStateStore();
        const project = await store.getProject(input.projectId);
        if (project) {
          await store.setVisualEvidence(input.projectId, evidence);
        }
        logToolEvent({
          level: "info",
          tool: "attach_visual_evidence",
          stage: "success",
          traceId,
          message: "Attached visual evidence artifact",
          data: { projectId: input.projectId, visualId: evidence.visualId, artifactPath: evidence.artifactPath },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ traceId, ok: true, ...evidence }, null, 2),
            },
          ],
        };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "attach_visual_evidence",
          stage: "failure",
          traceId,
          message: "Failed to attach visual evidence artifact",
          data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error) },
        });
        throwAsMcpToolError({
          tool: "attach_visual_evidence",
          traceId,
          error,
          defaultCode: "ATTACH_VISUAL_EVIDENCE_FAILED",
        });
      }
    },
  );
}
