import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { scoreDocumentationConfidence } from "../analysis/confidence.js";
import { createFeatureKey } from "../analysis/feature-key.js";
import { classifyManualWorthiness } from "../analysis/manual-worthiness.js";
import { createNotionClient } from "../lib/notion-client.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import type { EventSnapshot, ProjectState } from "../lib/state-store.js";
import type { AnalyzeDocumentationCandidateResult, AnalyzeFallbackReasonCode, EntryType } from "../types.js";
import { getStateStore } from "../lib/state-store.js";

const FALLBACK_REASON_CODES: Record<string, AnalyzeFallbackReasonCode> = {
  NONE: "none",
  NO_USABLE_EVIDENCE: "no_usable_evidence",
  ANALYZER_EXCEPTION_PERSISTED: "analyzer_exception_fallback_persisted",
  ANALYZER_EXCEPTION_PERSIST_FAILED: "analyzer_exception_fallback_persist_failed",
};

function toTitleCase(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function inferFeatureNameFromEvidence(summaries: string[]): string {
  const first = summaries.find((summary) => summary.trim().length > 0) ?? "Captured Feature Update";
  const normalized = first
    .replace(/^(add|added|create|created|implement|implemented|update|updated|fix|fixed)\s+/i, "")
    .replace(/[\.;:].*$/, "")
    .trim();

  return toTitleCase(normalized || "Captured Feature Update");
}

function inferModuleFromEvidence(haystack: string): string | undefined {
  const checks: Array<[string, string]> = [
    ["auth", "Auth"],
    ["billing", "Billing"],
    ["admin", "Admin Panel"],
    ["report", "Reports"],
    ["api", "API"],
    ["frontend", "Frontend"],
    ["backend", "Backend"],
  ];

  for (const [needle, moduleName] of checks) {
    if (haystack.includes(needle)) {
      return moduleName;
    }
  }

  return undefined;
}

function inferRoute(filesChanged: string[], summaries: string[]): string | undefined {
  const routeFromFile = filesChanged.find((path) => path.includes("/routes/") || path.includes("\\routes\\"));
  if (routeFromFile) {
    const normalized = routeFromFile.replaceAll("\\", "/");
    const match = normalized.match(/routes\/(.+?)\.[a-z0-9]+$/i);
    if (match?.[1]) {
      return `/${match[1]}`;
    }
  }

  const summaryRoute = summaries.join(" ").match(/\/(?:[a-z0-9\-_]+\/?)+/i);
  return summaryRoute?.[0];
}

function inferMergedOrReleased(eventTypes: string[]): boolean {
  return eventTypes.includes("pr_merged") || eventTypes.includes("release_tagged");
}

function inferTestsPassed(testStatuses: Array<string | undefined>, eventTypes: string[]): boolean {
  return testStatuses.includes("passed") || eventTypes.includes("tests_passed");
}

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

        const summaries = evidence.map((item) => item.summary);
        const filesChanged = evidence.flatMap((item) => item.filesChanged);
        const eventTypes = evidence.map((item) => item.eventType);
        const testStatuses = evidence.map((item) => item.testStatus);

        const featureName = inferFeatureNameFromEvidence(summaries);

        try {
          const evidenceHaystack = `${summaries.join(" ")} ${filesChanged.join(" ")}`.toLowerCase();
        const moduleName = inferModuleFromEvidence(evidenceHaystack);
        const route = inferRoute(filesChanged, summaries);

        const worthiness = classifyManualWorthiness({
          summary: summaries.join("\n"),
          filesChanged,
        });

        const featureKey = createFeatureKey({
          module: moduleName,
          featureName,
          route,
        });

        const existingHit = input.existingFeatureKeys?.includes(featureKey) ?? false;
        const confidence = scoreDocumentationConfidence({
          manualWorthy: worthiness.shouldDocument,
          featureNameMatched: summaries.join(" ").toLowerCase().includes(featureName.toLowerCase()),
          testsPassed: inferTestsPassed(testStatuses, eventTypes),
          mergedOrReleased: inferMergedOrReleased(eventTypes),
          concreteDocumentation: summaries.join(" ").length > 80,
          ambiguousPurpose: !worthiness.shouldDocument,
          duplicateUncertain: !existingHit && (input.existingFeatureKeys?.length ?? 0) > 0,
        });

        const audiences = worthiness.audiences;
        const entryTypes = audiences.flatMap<EntryType>((audience) => {
          if (audience === "User") {
            return ["User Guide"];
          }

          if (audience === "Admin") {
            return ["Admin Guide"];
          }

          return [];
        });

        const response: AnalyzeDocumentationCandidateResult = {
          shouldDocument: worthiness.shouldDocument,
          featureKey,
          featureName,
          audiences,
          entryTypes,
          confidenceScore: confidence.score,
          confidenceReasons: [...worthiness.reasons, ...confidence.reasons],
          reviewQuestions: confidence.reviewQuestions,
          fallbackStatus: null,
          fallbackEntryId: null,
          fallbackReasonCode: FALLBACK_REASON_CODES.NONE,
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
