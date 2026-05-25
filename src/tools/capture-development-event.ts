import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createNotionClient } from "../lib/notion-client.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { redactSecrets } from "../lib/redaction.js";
import { getStateStore } from "../lib/state-store.js";

const sourceSchema = z.enum(["local_git", "github", "ci", "release", "ai_session"]);
const eventTypeSchema = z.enum([
  "commit",
  "diff",
  "pr_opened",
  "pr_merged",
  "tests_passed",
  "release_tagged",
  "session_completed",
]);

export function registerCaptureDevelopmentEventTool(server: McpServer) {
  server.tool(
    "capture_development_event",
    "Stores raw development evidence from any signal source.",
    {
      projectId: z.string(),
      source: sourceSchema,
      eventType: eventTypeSchema,
      summary: z.string(),
      commitSha: z.string().optional(),
      branch: z.string().optional(),
      prUrl: z.string().url().optional(),
      releaseVersion: z.string().optional(),
      filesChanged: z.string().optional(),
      diffSummary: z.string().optional(),
      testStatus: z.enum(["passed", "failed", "unknown", "not_run"]).optional(),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "capture_development_event",
        stage: "start",
        traceId,
        message: "Capturing development evidence event",
        data: { projectId: input.projectId, eventType: input.eventType, source: input.source },
      });

      try {
        const store = getStateStore();
        const notion = createNotionClient();
        const project = await store.getProject(input.projectId);
        if (!project) {
          throw new Error("Unknown projectId. Run initialize_project_manual first.");
        }

        await runProjectPreflight({ notion, project });

        const redactedSummary = redactSecrets(input.summary);
        const redactedDiffSummary = input.diffSummary ? redactSecrets(input.diffSummary) : undefined;
        const normalizedFilesChanged = input.filesChanged
          ? input.filesChanged
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
          : [];
        const redactedFilesChanged = normalizedFilesChanged.map((value) => redactSecrets(value));

      const text = `${redactedSummary} ${redactedDiffSummary ?? ""} ${redactedFilesChanged.join(" ")}`.toLowerCase();
      const likelyManualWorthy = /page|screen|workflow|route|setting|permission|webhook|api|endpoint|billing|auth/.test(
        text,
      );
      const likelyNoise = /format|lint|prettier|refactor|test only/.test(text);
      const initialClassification = likelyNoise ? "false" : likelyManualWorthy ? "true" : "uncertain";

        const sourceLabel: Record<z.infer<typeof sourceSchema>, string> = {
        local_git: "Local Git",
        github: "GitHub",
        ci: "CI",
        release: "Release",
        ai_session: "AI Session",
        };

        const eventTypeLabel: Record<z.infer<typeof eventTypeSchema>, string> = {
        commit: "Commit",
        diff: "Diff",
        pr_opened: "PR Opened",
        pr_merged: "PR Merged",
        tests_passed: "Tests Passed",
        release_tagged: "Release Tagged",
        session_completed: "Session Completed",
        };

        const testStatusLabel: Record<"passed" | "failed" | "unknown" | "not_run", string> = {
        passed: "Passed",
        failed: "Failed",
        unknown: "Unknown",
        not_run: "Not Run",
        };

        const externalEventId = `evt_${Date.now()}`;
        const payload = {
        parent: { database_id: project.databases.evidenceEventsDatabaseId },
        properties: {
          "Event Title": { title: [{ text: { content: redactedSummary.slice(0, 120) } }] },
          Source: { select: { name: sourceLabel[input.source] } },
          "Event Type": { select: { name: eventTypeLabel[input.eventType] } },
          ...(input.commitSha
            ? { "Commit SHA": { rich_text: [{ text: { content: input.commitSha } }] } }
            : {}),
          ...(input.branch ? { Branch: { rich_text: [{ text: { content: input.branch } }] } } : {}),
          ...(input.prUrl ? { "PR URL": { url: input.prUrl } } : {}),
          ...(input.releaseVersion
            ? { "Release Version": { rich_text: [{ text: { content: input.releaseVersion } }] } }
            : {}),
          ...(redactedFilesChanged.length > 0
            ? { "Files Changed": { rich_text: [{ text: { content: redactedFilesChanged.join(", ") } }] } }
            : {}),
          ...(redactedDiffSummary
            ? { "Diff Summary": { rich_text: [{ text: { content: redactedDiffSummary } }] } }
            : {}),
          ...(input.testStatus ? { "Test Status": { select: { name: testStatusLabel[input.testStatus] } } } : {}),
          "Captured At": { date: { start: new Date().toISOString() } },
          Project: { relation: [{ id: project.projectPageId ?? project.projectId }] },
        },
        };

        const page = await withNotionRetry(() =>
          notion.pages.create(payload),
          {
          operationName: "pages.create",
          payload,
          },
        );

        await store.setEvent(input.projectId, externalEventId, page.id);
        await store.setEventSnapshot(input.projectId, externalEventId, {
        summary: redactedSummary,
        filesChanged: redactedFilesChanged,
        diffSummary: redactedDiffSummary,
        commitSha: input.commitSha,
        branch: input.branch,
        eventType: input.eventType,
        source: input.source,
        testStatus: input.testStatus,
        });

        logToolEvent({
        level: "info",
        tool: "capture_development_event",
        stage: "success",
        traceId,
        message: "Captured development evidence event",
        data: {
          projectId: input.projectId,
          evidenceEventId: externalEventId,
          initialClassification,
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
                  evidenceEventId: externalEventId,
                  evidencePageId: page.id,
                  initialClassification,
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
          tool: "capture_development_event",
          stage: "failure",
          traceId,
          message: "Failed to capture development evidence event",
          data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "capture_development_event",
          traceId,
          error,
          defaultCode: "CAPTURE_DEVELOPMENT_EVENT_FAILED",
        });
      }
    },
  );
}
