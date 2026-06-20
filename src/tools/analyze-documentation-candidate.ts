import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { scoreDocumentationConfidence } from "../analysis/confidence.js";
import { createFeatureKey } from "../analysis/feature-key.js";
import { classifyManualWorthiness } from "../analysis/manual-worthiness.js";
import { analyzeDocumentationCandidate, ProviderOutputInvalidError } from "../lib/analyzer.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import type { EventSnapshot } from "../lib/state-store.js";
import type { AnalyzeDocumentationCandidateResult, AnalyzeFallbackReasonCode, EntryType } from "../types.js";
import { getStateStore } from "../lib/state-store.js";

const FALLBACK_REASON_CODES: Record<string, AnalyzeFallbackReasonCode> = {
  NONE: "none",
  NO_USABLE_EVIDENCE: "no_usable_evidence",
  PROVIDER_OUTPUT_INVALID: "provider_output_invalid",
  ANALYZER_EXCEPTION: "analyzer_exception",
};

function fallbackGeneratedNarratives(providerUsed: string) {
  return {
    providerUsed,
    userGuide: {
      summary: "",
      steps: [] as string[],
      expectedOutcome: "",
      possibleErrors: [] as string[],
    },
    adminGuide: {
      configRequired: [] as string[],
      endpointsAffected: [] as string[],
      envVarsRequired: [] as string[],
      verificationSteps: [] as string[],
      troubleshooting: [] as string[],
    },
  };
}

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

function titleFromFilePath(filePath: string): string {
  const baseName = filePath
    .replaceAll("\\", "/")
    .split("/")
    .pop()
    ?.replace(/\.[a-z0-9]+$/i, "")
    .trim();
  const title = toTitleCase(baseName ?? "");
  return title ? `${title} Helpers` : "Captured Feature Update";
}

function hasGitPlumbingFeatureName(input: string): boolean {
  return (
    /\bcommit\s+[a-f0-9]{7,40}\b/i.test(input) ||
    /\bAuthor:/i.test(input) ||
    /<[^>\s]+@[^>]+>/.test(input) ||
    /[<>]/.test(input)
  );
}

function inferCleanFeatureName(input: { inferredFeatureName: string; filesChanged: string[] }): string {
  const primaryFile = input.filesChanged.find((filePath) => /\.(?:[cm]?[jt]sx?|tsx?|py|go|rs|java|cs)$/i.test(filePath)) ?? input.filesChanged[0];
  if (hasGitPlumbingFeatureName(input.inferredFeatureName) && primaryFile) {
    return titleFromFilePath(primaryFile);
  }

  return hasGitPlumbingFeatureName(input.inferredFeatureName) ? "Captured Feature Update" : input.inferredFeatureName;
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
          generatedNarratives: fallbackGeneratedNarratives("deterministic"),
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
        const featureName = inferCleanFeatureName({
          inferredFeatureName: inferFeatureNameFromEvidence(summaries),
          filesChanged: evidence.flatMap((item) => item.filesChanged),
        });

        try {
          const analysis = await analyzeDocumentationCandidate({
            projectId: input.projectId,
            evidence,
            existingFeatureKeys: input.existingFeatureKeys,
          });
          const {
            dedupeDecision: _dedupeDecision,
            matchedExistingFeatureKey: _matchedExistingFeatureKey,
            ...response
          } = analysis;
          const responseWithNarratives = {
            ...response,
            generatedNarratives: response.generatedNarratives ?? fallbackGeneratedNarratives(
              response.confidenceReasons.find((reason) => reason.startsWith("Provider used: "))?.replace("Provider used: ", "") ?? "deterministic",
            ),
          };

        logToolEvent({
          level: "info",
          tool: "analyze_documentation_candidate",
          stage: "success",
          traceId,
          message: "Analyzed documentation candidate",
          data: {
            projectId: input.projectId,
            shouldDocument: responseWithNarratives.shouldDocument,
            confidenceScore: responseWithNarratives.confidenceScore,
            durationMs: Date.now() - startedAt,
          },
        });

          return {
            content: [
              {
                  type: "text",
                  text: JSON.stringify({ ...responseWithNarratives, traceId }, null, 2),
                },
              ],
            };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown analyzer failure.";
        if (error instanceof ProviderOutputInvalidError) {
          const response: AnalyzeDocumentationCandidateResult = {
            shouldDocument: false,
            featureKey: "general:provider-output-invalid",
            featureName,
            audiences: [],
            entryTypes: [],
            confidenceScore: 0,
            confidenceReasons: [
              "Provider output invalid; topic was not persisted as a Captured fallback shell.",
              `Provider output error: ${errorMessage}`,
            ],
            reviewQuestions: [
              "Did the provider return the required analyzer JSON schema?",
              "Should the provider be retried with a stricter schema prompt?",
            ],
            fallbackStatus: null,
            fallbackEntryId: null,
            fallbackReasonCode: FALLBACK_REASON_CODES.PROVIDER_OUTPUT_INVALID,
            generatedNarratives: fallbackGeneratedNarratives("provider_output_invalid"),
          };

          logToolEvent({
            level: "error",
            tool: "analyze_documentation_candidate",
            stage: "provider_output_invalid",
            traceId,
            message: "Provider output invalid; returning visible failure response",
            data: {
              projectId: input.projectId,
              fallbackReasonCode: response.fallbackReasonCode,
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
        const response: AnalyzeDocumentationCandidateResult = {
          shouldDocument: false,
          featureKey: "general:captured-feature-update",
          featureName,
          audiences: [],
          entryTypes: [],
          confidenceScore: 0,
          confidenceReasons: [
            "Analyzer failed; topic was not persisted as a Captured fallback shell.",
            `Analyzer error: ${errorMessage}`,
          ],
          reviewQuestions: [
            "What changed functionally for users or admins?",
            "Should this captured signal be promoted to a full manual entry?",
          ],
          fallbackStatus: null,
          fallbackEntryId: null,
          fallbackReasonCode: FALLBACK_REASON_CODES.ANALYZER_EXCEPTION,
          generatedNarratives: fallbackGeneratedNarratives("analyzer_exception"),
        };

        logToolEvent({
          level: "error",
          tool: "analyze_documentation_candidate",
          stage: "analyzer_exception",
          traceId,
          message: "Analyzer failed; returning visible failure response",
          data: {
            projectId: input.projectId,
            fallbackReasonCode: response.fallbackReasonCode,
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
