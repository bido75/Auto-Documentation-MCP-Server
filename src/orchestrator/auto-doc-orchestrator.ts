import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { collectGitEvidence } from "../evidence/git.js";
import { authorManualSection } from "../lib/manual-author.js";
import { getStateStore, type ProjectState } from "../lib/state-store.js";
import { registerAnalyzeDocumentationCandidateTool } from "../tools/analyze-documentation-candidate.js";
import { registerCaptureDevelopmentEventTool } from "../tools/capture-development-event.js";
import { registerPublishOrQueueReviewTool } from "../tools/publish-or-queue-review.js";
import { registerUpsertFeatureDocumentationTool } from "../tools/upsert-feature-documentation.js";
import type { Audience, EntryType } from "../types.js";

export type AutonomousTriggerInput = {
  projectId: string;
  repoPath?: string;
  mode: "staged" | "last_commit" | "working_tree";
  source?: string;
  eventType?: string;
  summary?: string;
  diffSummary?: string;
  filesChanged?: string[] | string;
  commitSha?: string;
  branch?: string;
  prUrl?: string;
  prTitle?: string;
  prBody?: string;
  prNumber?: number;
  baseBranch?: string;
  headBranch?: string;
  issueReferences?: string[];
  releaseVersion?: string;
  testStatus?: string;
  traceId?: string;
  signal?: AbortSignal;
};

type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
};

type ToolHandler = (input: unknown) => Promise<ToolCallResult>;

type CaptureInput = {
  projectId: string;
  source: "local_git" | "github" | "ci" | "release" | "ai_session";
  eventType: "commit" | "diff" | "pr_opened" | "pr_merged" | "tests_passed" | "release_tagged" | "session_completed";
  summary: string;
  commitSha?: string;
  branch?: string;
  prUrl?: string;
  releaseVersion?: string;
  filesChanged?: string;
  diffSummary?: string;
  testStatus?: "passed" | "failed" | "unknown" | "not_run";
  traceId?: string;
  externalEventId?: string;
};

type AnalyzeResponse = {
  shouldDocument: boolean;
  featureKey: string;
  featureName: string;
  audiences: Audience[];
  entryTypes: EntryType[];
  confidenceScore: number;
  confidenceReasons: string[];
  reviewQuestions: string[];
  fallbackStatus: "Captured" | null;
  fallbackEntryId: string | null;
  fallbackReasonCode: string;
  generatedNarratives?: {
    providerUsed: string;
    userGuide: {
      summary: string;
      steps: string[];
      expectedOutcome: string;
      possibleErrors: string[];
    };
    adminGuide: {
      configRequired: string[];
      endpointsAffected: string[];
      envVarsRequired: string[];
      verificationSteps: string[];
      troubleshooting: string[];
    };
    developerNotes?: string;
  };
  traceId: string;
};

type CaptureResponse = {
  traceId: string;
  evidenceEventId: string;
  evidencePageId: string;
  initialClassification: string;
};

type UpsertResponse = {
  traceId: string;
  featureId: string;
  featureName: string;
  featureKey: string;
  evidenceEventIds: string[];
  publishing: { status: string; decision: string };
  manualEntries: Array<{ pageId: string; url?: string }>;
};

type PublishResponse = {
  traceId: string;
  featureId: string;
  manualEntryIds: string[];
  finalStatus: string;
  publishingDecision: string;
  reviewNotes: string;
};

export type AutonomousTriggerResult = {
  ok: true;
  projectId: string;
  repoPath?: string;
  mode: AutonomousTriggerInput["mode"];
  disposition: "documented" | "duplicate" | "skipped";
  documentedFeatureCount: number;
  analyzerFailureCount: number;
  skippedCount: number;
  duplicateCount: number;
  capture: CaptureResponse;
  analysis: AnalyzeResponse;
  upsert: { featureId: string; manualEntryIds: string[] } | null;
  publish: PublishResponse | null;
};

class InMemoryToolHost {
  public readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

function parseToolResult<T>(result: ToolCallResult): T {
  const text = result.content[0]?.text;
  if (!text) {
    throw new Error("Internal tool returned an empty response.");
  }

  return JSON.parse(text) as T;
}

function getHandler(host: InMemoryToolHost, name: string): ToolHandler {
  const handler = host.handlers.get(name);
  if (!handler) {
    throw new Error(`Internal tool '${name}' was not registered.`);
  }

  return handler;
}

function normalizeSource(value: string | undefined): CaptureInput["source"] {
  const allowed: CaptureInput["source"][] = ["local_git", "github", "ci", "release", "ai_session"];
  return allowed.find((candidate) => candidate === value) ?? "local_git";
}

function normalizeEventType(value: string | undefined, mode: AutonomousTriggerInput["mode"]): CaptureInput["eventType"] {
  const allowed: CaptureInput["eventType"][] = [
    "commit",
    "diff",
    "pr_opened",
    "pr_merged",
    "tests_passed",
    "release_tagged",
    "session_completed",
  ];
  const normalized = allowed.find((candidate) => candidate === value);
  if (normalized) {
    return normalized;
  }

  return mode === "last_commit" ? "commit" : "diff";
}

function normalizeTestStatus(value: string | undefined): CaptureInput["testStatus"] | undefined {
  const allowed: Array<NonNullable<CaptureInput["testStatus"]>> = ["passed", "failed", "unknown", "not_run"];
  return allowed.find((candidate) => candidate === value);
}

function normalizePublishingMode(mode: ProjectState["publishingMode"]): "conservative" | "balanced" | "fully_automatic" {
  if (mode === "Conservative") {
    return "conservative";
  }

  if (mode === "Fully Automatic") {
    return "fully_automatic";
  }

  return "balanced";
}

function normalizeFilesChanged(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function buildExternalEventId(input: {
  projectId: string;
  repoPath?: string;
  mode: AutonomousTriggerInput["mode"];
  captureInput: Omit<CaptureInput, "externalEventId">;
}): string {
  const stableSignal = input.captureInput.commitSha
    ? `${input.captureInput.source}:${input.captureInput.eventType}:${input.captureInput.commitSha}`
    : [
        input.captureInput.source,
        input.captureInput.eventType,
        input.repoPath ?? "",
        input.mode,
        input.captureInput.branch ?? "",
        input.captureInput.summary,
        input.captureInput.diffSummary ?? "",
        input.captureInput.filesChanged ?? "",
      ].join("\n");
  const digest = createHash("sha256").update(`${input.projectId}\n${stableSignal}`).digest("hex").slice(0, 24);
  return `evt_${input.captureInput.source}_${input.captureInput.eventType}_${digest}`;
}

function extractRoute(filesChanged: string[]): string[] {
  const routes = new Set<string>();
  for (const file of filesChanged) {
    const normalized = file.replaceAll("\\", "/");
    const match = normalized.match(/routes\/(.+?)\.[a-z0-9]+$/i);
    if (match?.[1]) {
      routes.add(`/${match[1]}`);
    }
  }

  return [...routes];
}

function analyzerFailed(analysis: AnalyzeResponse): boolean {
  return (
    analysis.fallbackReasonCode === "provider_output_invalid" ||
    analysis.fallbackReasonCode === "analyzer_exception" ||
    analysis.fallbackReasonCode === "analyzer_exception_fallback_persisted" ||
    analysis.fallbackReasonCode === "analyzer_exception_fallback_persist_failed"
  );
}

function resultCounts(disposition: AutonomousTriggerResult["disposition"], analysis: AnalyzeResponse) {
  return {
    documentedFeatureCount: disposition === "documented" ? 1 : 0,
    analyzerFailureCount: analyzerFailed(analysis) ? 1 : 0,
    skippedCount: disposition === "skipped" ? 1 : 0,
    duplicateCount: disposition === "duplicate" ? 1 : 0,
  };
}

async function buildManualEntries(input: {
  analysis: AnalyzeResponse;
  captureInput: CaptureInput;
  filesChanged: string[];
  repoPath?: string;
}): Promise<Array<{
  entryType: EntryType;
  title: string;
  userGuide: string;
  adminGuide: string;
  developerNotes?: string;
  routes?: string[];
  apiEndpoints?: string[];
}>> {
  const entryTypes = input.analysis.entryTypes.length > 0 ? input.analysis.entryTypes : (["Developer Note"] as EntryType[]);
  const routes = extractRoute(input.filesChanged);
  const entries = [];

  for (const entryType of entryTypes) {
    const audience: Audience =
      entryType === "User Guide" ? "User" : entryType === "Admin Guide" ? "Admin" : "Internal";
    const authored = await authorManualSection({
      audience,
      entryType,
      featureName: input.analysis.featureName,
      summary: input.captureInput.summary,
      diffSummary: input.captureInput.diffSummary,
      filesChanged: input.filesChanged,
      repoPath: input.repoPath,
      providerNarrative: input.analysis.generatedNarratives,
    });

    entries.push({
      entryType,
      title: `${input.analysis.featureName} ${entryType}`,
      userGuide: entryType === "User Guide" ? authored.body : "",
      adminGuide: entryType === "Admin Guide" ? authored.body : "",
      developerNotes: entryType !== "User Guide" && entryType !== "Admin Guide" ? authored.body : undefined,
      routes: routes.length > 0 ? routes : undefined,
    });
  }

  return entries;
}

async function buildCaptureInput(input: AutonomousTriggerInput): Promise<CaptureInput> {
  const filesChanged = normalizeFilesChanged(input.filesChanged);
  if (input.summary) {
    const captureInput: Omit<CaptureInput, "externalEventId"> = {
      projectId: input.projectId,
      source: normalizeSource(input.source),
      eventType: normalizeEventType(input.eventType, input.mode),
      summary: input.summary,
      commitSha: input.commitSha,
      branch: input.branch,
      prUrl: input.prUrl,
      releaseVersion: input.releaseVersion,
      filesChanged: filesChanged.length > 0 ? filesChanged.join(", ") : undefined,
      diffSummary: input.diffSummary,
      testStatus: normalizeTestStatus(input.testStatus),
      traceId: input.traceId,
    };

    return {
      ...captureInput,
      externalEventId: buildExternalEventId({
        projectId: input.projectId,
        repoPath: input.repoPath,
        mode: input.mode,
        captureInput,
      }),
    };
  }

  if (!input.repoPath) {
    throw new Error("repoPath is required when summary evidence is not provided.");
  }

  const evidence = await collectGitEvidence({ repoPath: input.repoPath, mode: input.mode });

  const captureInput: Omit<CaptureInput, "externalEventId"> = {
    projectId: input.projectId,
    source: "local_git",
    eventType: evidence.eventType === "Commit" ? "commit" : "diff",
    summary: evidence.summary,
    commitSha: evidence.commitSha,
    branch: evidence.branch,
    filesChanged: evidence.filesChanged.length > 0 ? evidence.filesChanged.join(", ") : undefined,
    diffSummary: evidence.diffSummary,
    testStatus: normalizeTestStatus(input.testStatus),
    traceId: input.traceId,
  };

  return {
    ...captureInput,
    externalEventId: buildExternalEventId({
      projectId: input.projectId,
      repoPath: input.repoPath,
      mode: input.mode,
      captureInput,
    }),
  };
}

export async function executeAutonomousDocumentationTrigger(input: AutonomousTriggerInput): Promise<AutonomousTriggerResult> {
  const store = getStateStore();
  const project = await store.getProject(input.projectId);
  if (!project) {
    throw new Error("Unknown projectId. Run initialize_project_manual first.");
  }

  const host = new InMemoryToolHost();
  const server = host as unknown as McpServer;
  registerCaptureDevelopmentEventTool(server);
  registerAnalyzeDocumentationCandidateTool(server);
  registerUpsertFeatureDocumentationTool(server);
  registerPublishOrQueueReviewTool(server);

  const captureInput = await buildCaptureInput(input);
  const capture = parseToolResult<CaptureResponse>(await getHandler(host, "capture_development_event")(captureInput));
  const existingFeatureKeys = Object.keys(project.featuresByKey);
  const analysis = parseToolResult<AnalyzeResponse>(
    await getHandler(host, "analyze_documentation_candidate")({
      projectId: input.projectId,
      evidenceEventIds: [capture.evidenceEventId],
      existingFeatureKeys,
      traceId: input.traceId,
    }),
  );

  const duplicateFeatureId = await store.getFeature(input.projectId, analysis.featureKey);
  if (duplicateFeatureId) {
    const counts = resultCounts("duplicate", analysis);
    return {
      ok: true,
      projectId: input.projectId,
      repoPath: input.repoPath,
      mode: input.mode,
      disposition: "duplicate",
      ...counts,
      capture,
      analysis,
      upsert: null,
      publish: null,
    };
  }

  if (!analysis.shouldDocument) {
    const counts = resultCounts("skipped", analysis);
    return {
      ok: true,
      projectId: input.projectId,
      repoPath: input.repoPath,
      mode: input.mode,
      disposition: "skipped",
      ...counts,
      capture,
      analysis,
      upsert: null,
      publish: null,
    };
  }

  const captureFilesChanged = normalizeFilesChanged(captureInput.filesChanged);
  const publishingMode = normalizePublishingMode(project.publishingMode);
  const upsert = parseToolResult<UpsertResponse>(
    await getHandler(host, "upsert_feature_documentation")({
      projectId: input.projectId,
      featureKey: analysis.featureKey,
      featureName: analysis.featureName,
      audiences: analysis.audiences,
      manualEntries: await buildManualEntries({ analysis, captureInput, filesChanged: captureFilesChanged, repoPath: input.repoPath }),
      evidenceEventIds: [capture.evidenceEventId],
      confidenceScore: analysis.confidenceScore,
      confidenceReasons: analysis.confidenceReasons,
      publishingMode,
      autoPublishThreshold: project.autoPublishThreshold,
      sourceCommit: captureInput.commitSha,
      sourcePr: input.prUrl,
      filesChanged: captureFilesChanged,
      traceId: input.traceId,
    }),
  );

  const manualEntryIds = upsert.manualEntries.map((entry) => entry.pageId);
  const publish = parseToolResult<PublishResponse>(
    await getHandler(host, "publish_or_queue_review")({
      projectId: input.projectId,
      featureId: upsert.featureId,
      manualEntryIds,
      confidenceScore: analysis.confidenceScore,
      publishingMode,
      autoPublishThreshold: project.autoPublishThreshold,
      traceId: input.traceId,
    }),
  );

  const counts = resultCounts("documented", analysis);
  return {
    ok: true,
    projectId: input.projectId,
    repoPath: input.repoPath,
    mode: input.mode,
    disposition: "documented",
    ...counts,
    capture,
    analysis,
    upsert: { featureId: upsert.featureId, manualEntryIds },
    publish,
  };
}
