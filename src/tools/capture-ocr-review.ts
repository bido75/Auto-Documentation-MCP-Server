import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { registerCaptureDevelopmentEventTool } from "./capture-development-event.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;

class ToolHost {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

const findingSchema = z.object({
  file: z.string(),
  line: z.number().optional(),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  title: z.string(),
  description: z.string().optional(),
  recommendation: z.string().optional(),
});

function formatFindings(findings: Array<z.infer<typeof findingSchema>>): string {
  return findings
    .map((finding) => {
      const location = `${finding.file}${finding.line ? `:${finding.line}` : ""}`;
      const severity = finding.severity ? `[${finding.severity}] ` : "";
      const details = [finding.description, finding.recommendation ? `Recommendation: ${finding.recommendation}` : ""].filter(Boolean).join(" ");
      return `- ${severity}${location} ${finding.title}${details ? ` — ${details}` : ""}`;
    })
    .join("\n");
}

export function registerCaptureOcrReviewTool(server: McpServer): void {
  server.tool(
    "capture_ocr_review",
    "Captures Open Code Review findings as documentation evidence so security/API changes can be documented.",
    {
      projectId: z.string(),
      reviewId: z.string().optional(),
      prUrl: z.string().url().optional(),
      commitSha: z.string().optional(),
      branch: z.string().optional(),
      summary: z.string(),
      findings: z.array(findingSchema),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "capture_ocr_review",
        stage: "start",
        traceId,
        message: "Capturing Open Code Review evidence",
        data: { projectId: input.projectId, findingCount: input.findings.length },
      });

      try {
        const host = new ToolHost();
        registerCaptureDevelopmentEventTool(host as unknown as McpServer);
        const capture = host.handlers.get("capture_development_event");
        if (!capture) {
          throw new Error("Failed to initialize capture_development_event.");
        }

        const filesChanged = Array.from(new Set(input.findings.map((finding) => finding.file)));
        const result = await capture({
          projectId: input.projectId,
          source: "ai_session",
          eventType: "session_completed",
          summary: `Open Code Review: ${input.summary}`,
          diffSummary: formatFindings(input.findings),
          filesChanged: filesChanged.join(", "),
          commitSha: input.commitSha,
          branch: input.branch,
          prUrl: input.prUrl,
          testStatus: "unknown",
          externalEventId: input.reviewId ? `ocr:${input.reviewId}` : undefined,
          traceId,
        });

        const parsed = JSON.parse(result.content[0]?.text ?? "{}") as { evidenceEventId?: string; evidencePageId?: string };
        logToolEvent({
          level: "info",
          tool: "capture_ocr_review",
          stage: "success",
          traceId,
          message: "Captured Open Code Review evidence",
          data: { projectId: input.projectId, evidenceEventId: parsed.evidenceEventId, durationMs: Date.now() - startedAt },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ traceId, ...parsed, findingCount: input.findings.length, filesChanged }, null, 2),
            },
          ],
        };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "capture_ocr_review",
          stage: "failure",
          traceId,
          message: "Failed to capture Open Code Review evidence",
          data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({ tool: "capture_ocr_review", traceId, error, defaultCode: "CAPTURE_OCR_REVIEW_FAILED" });
      }
    },
  );
}

