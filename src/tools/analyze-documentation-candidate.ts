import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createNotionClient } from "../lib/notion-client.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { analyzeDocumentationCandidate } from "../lib/analyzer.js";
import type { EventSnapshot, ProjectState } from "../lib/state-store.js";
import type { AnalyzeDocumentationCandidateResult, AnalyzeFallbackReasonCode } from "../types.js";
import { getStateStore } from "../lib/state-store.js";

const FALLBACK_REASON_CODES: Record<string, AnalyzeFallbackReasonCode> = {
  NONE: "none",
  NO_USABLE_EVIDENCE: "no_usable_evidence",
  ANALYZER_EXCEPTION_PERSISTED: "analyzer_exception_fallback_persisted",
  ANALYZER_EXCEPTION_PERSIST_FAILED: "analyzer_exception_fallback_persist_failed",
};

async function persistCapturedAnalyzerFallback(input: {
  project: ProjectState;
  evidence: EventSnapshot[];
  featureName: string;
  errorMessage: string;
}) {
  const notion = createNotionClient();
  await runProjectPreflight({ notion, project: input.project });
  const firstCommit = input.evidence.find((item) => item.commitSha)?.commitSha;
  const filesChanged = input.evidence.flatMap((item) => item.filesChanged).filter(Boolean);

  const payload = {
    parent: { database_id: input.project.databases.manualEntriesDatabaseId },
    properties: {
      "Entry Title": { title: [{ text: { content: `Captured: ${input.featureName}` } }] },
      "Entry Type": { select: { name: "Developer Note" } },
      Audience: { select: { name: "Internal" } },
      Status: { status: { name: "Captured" } },
      "Confidence Score": { number: 0 },
      "Publishing Decision": { select: { name: "Queued Review" } },
      "Reviewer Notes": {
        rich_text: [{ text: { content: `Analyzer failure fallback: ${input.errorMessage.slice(0, 1000)}` } }],
      },
      ...(firstCommit ? { "Source Commit": { rich_text: [{ text: { content: firstCommit } }] } } : {}),
      ...(filesChanged.length > 0
        ? {
            "Files Changed": {
              rich_text: [{ text: { content: filesChanged.join("\n").slice(0, 1800) } }],
            },
          }
        : {}),
      "Date Captured": { date: { start: new Date().toISOString().slice(0, 10) } },
      Project: { relation: [{ id: input.project.projectPageId ?? input.project.projectId }] },
    },
  };

  const page = await withNotionRetry(() => notion.pages.create(payload as never), {
    operationName: "pages.create",
    payload,
  });

  return page.id;
}

export function registerAnalyzeDocumentationCandidateTool(server: McpServer) {
  server.tool(
    "analyze_documentation_candidate",
    "Classifies evidence and computes confidence for documentation generation.",
    {
      projectId: z.string(),
      evidenceEventIds: z.array(z.string()),
      existingFeatureKeys: z.array(z.string()).optional(),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "analyze_documentation_candidate",
        stage: "start",
        traceId,
        message: "Analyzing documentation candidate",
        data: { projectId: input.projectId, evidenceEventCount: input.evidenceEventIds.length },
      });

      try {
        const store = getStateStore();
        const project = await store.getProject(input.projectId);
        if (!project) {
          throw new Error("Unknown projectId. Run initialize_project_manual first.");
        }

        const snapshots = await Promise.all(
          input.evidenceEventIds.map((eventId) => store.getEventSnapshot(input.projectId, eventId)),
        );
        const evidence = snapshots.filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);

        if (evidence.length === 0) {
          const response: AnalyzeDocumentationCandidateResult = {
            shouldDocument: false,
            featureKey: "general:captured-feature-update",
            featureName: "Captured Feature Update",
            audiences: [],
            entryTypes: [],
            confidenceScore: 0,
            confidenceReasons: ["No usable evidence snapshots found for provided evidenceEventIds."],
            reviewQuestions: ["Was the evidence event captured successfully before analysis?"],
            fallbackStatus: "Captured",
            fallbackEntryId: null,
            fallbackReasonCode: FALLBACK_REASON_CODES.NO_USABLE_EVIDENCE,
            generatedNarratives: null,
          };

          logToolEvent({
          level: "warn",
          tool: "analyze_documentation_candidate",
          stage: "fallback_no_evidence",
          traceId,
          message: "No usable evidence snapshots found",
          data: { projectId: input.projectId, durationMs: Date.now() - startedAt },
        });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...response, traceId }, null, 2),
              },
            ],
          };
        }

        const featureName = evidence[0]?.summary || "Captured Feature Update";

        try {
          const analyzed = await analyzeDocumentationCandidate({
            evidence,
            existingFeatureKeys: input.existingFeatureKeys,
          });

        const response: AnalyzeDocumentationCandidateResult = {
          shouldDocument: analyzed.shouldDocument,
          featureKey: analyzed.featureKey,
          featureName: analyzed.featureName,
          audiences: analyzed.audiences,
          entryTypes: analyzed.entryTypes,
          confidenceScore: analyzed.confidenceScore,
          confidenceReasons: analyzed.confidenceReasons,
          reviewQuestions: analyzed.reviewQuestions,
          fallbackStatus: null,
          fallbackEntryId: null,
          fallbackReasonCode: FALLBACK_REASON_CODES.NONE,
          dedupeDecision: analyzed.dedupeDecision,
          matchedExistingFeatureKey: analyzed.matchedExistingFeatureKey,
          generatedNarratives: analyzed.generatedNarratives,
        };

        logToolEvent({
          level: "info",
          tool: "analyze_documentation_candidate",
          stage: "success",
          traceId,
          message: "Analyzed documentation candidate",
          data: {
            projectId: input.projectId,
            shouldDocument: response.shouldDocument,
            confidenceScore: response.confidenceScore,
            dedupeDecision: response.dedupeDecision,
            matchedExistingFeatureKey: response.matchedExistingFeatureKey,
            generatedNarratives: response.generatedNarratives !== null,
            durationMs: Date.now() - startedAt,
          },
        });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...response, traceId }, null, 2),
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown analyzer failure.";
        let fallbackEntryId: string | undefined;
        let fallbackPersistenceError: string | undefined;

        try {
          fallbackEntryId = await persistCapturedAnalyzerFallback({
            project,
            evidence,
            featureName,
            errorMessage,
          });
        } catch (persistError) {
          fallbackPersistenceError = persistError instanceof Error ? persistError.message : String(persistError);
        }

        const response: AnalyzeDocumentationCandidateResult = {
          shouldDocument: false,
          featureKey: "general:captured-feature-update",
          featureName,
          audiences: [],
          entryTypes: [],
          confidenceScore: 0,
          confidenceReasons: [
            "Analyzer failed; signal captured as a manual entry with status Captured.",
            `Analyzer error: ${errorMessage}`,
            ...(fallbackPersistenceError
              ? [`Fallback persistence failed: ${fallbackPersistenceError}`]
              : ["Fallback persistence succeeded."]),
          ],
          reviewQuestions: [
            "What changed functionally for users or admins?",
            "Should this captured signal be promoted to a full manual entry?",
          ],
          fallbackStatus: "Captured",
          fallbackEntryId: fallbackEntryId ?? null,
          fallbackReasonCode: fallbackPersistenceError
            ? FALLBACK_REASON_CODES.ANALYZER_EXCEPTION_PERSIST_FAILED
            : FALLBACK_REASON_CODES.ANALYZER_EXCEPTION_PERSISTED,
            generatedNarratives: null,
        };

        logToolEvent({
          level: fallbackPersistenceError ? "error" : "warn",
          tool: "analyze_documentation_candidate",
          stage: "fallback_analyzer_failure",
          traceId,
          message: "Analyzer failed; returning fallback response",
          data: {
            projectId: input.projectId,
            fallbackReasonCode: response.fallbackReasonCode,
            fallbackEntryId: response.fallbackEntryId,
            durationMs: Date.now() - startedAt,
          },
        });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ...response, traceId }, null, 2),
              },
            ],
          };
        }
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "analyze_documentation_candidate",
          stage: "failure",
          traceId,
          message: "Failed to analyze documentation candidate",
          data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "analyze_documentation_candidate",
          traceId,
          error,
          defaultCode: "ANALYZE_DOCUMENTATION_CANDIDATE_FAILED",
        });
      }
    },
  );
}
