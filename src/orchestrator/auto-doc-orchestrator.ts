import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { collectGitEvidence } from "../evidence/git.js";
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

function buildManualEntries(input: {
  analysis: AnalyzeResponse;
  captureInput: CaptureInput;
  filesChanged: string[];
}): Array<{
  entryType: EntryType;
  title: string;
  userGuide: string;
  adminGuide: string;
  developerNotes?: string;
  routes?: string[];
  apiEndpoints?: string[];
}> {
  const entryTypes = input.analysis.entryTypes.length > 0 ? input.analysis.entryTypes : (["Developer Note"] as EntryType[]);
  const routes = extractRoute(input.filesChanged);
  const filesList = input.filesChanged.length > 0 ? `\n\nFiles changed:\n${input.filesChanged.map((file) => `- ${file}`).join("\n")}` : "";
  const diff = input.captureInput.diffSummary ? `\n\nImplementation notes:\n${input.captureInput.diffSummary}` : "";
  const body = `${input.captureInput.summary}${diff}${filesList}`;

  return entryTypes.map((entryType) => ({
    entryType,
    title: `${input.analysis.featureName} ${entryType}`,
    userGuide: body,
    adminGuide: body,
    developerNotes: body,
    routes: routes.length > 0 ? routes : undefined,
  }));
}

async function buildCaptureInput(input: AutonomousTriggerInput): Promise<CaptureInput> {
  const filesChanged = normalizeFilesChanged(input.filesChanged);
  if (input.summary) {
    return {
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
  }

  if (!input.repoPath) {
    throw new Error("repoPath is required when summary evidence is not provided.");
  }

  const evidence = await collectGitEvidence({ repoPath: input.repoPath, mode: input.mode });

  return {
    projectId: input.projectId,
    source: "local_git",
    eventType: evidence.eventType === "Commit" ? "commit" : "diff",
    summary: evidence.summary,
    branch: evidence.branch,
    filesChanged: evidence.filesChanged.length > 0 ? evidence.filesChanged.join(", ") : undefined,
    testStatus: normalizeTestStatus(input.testStatus),
    traceId: input.traceId,
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
    return {
      ok: true,
      projectId: input.projectId,
      repoPath: input.repoPath,
      mode: input.mode,
      disposition: "duplicate",
      capture,
      analysis,
      upsert: null,
      publish: null,
    };
  }

  if (!analysis.shouldDocument) {
    return {
      ok: true,
      projectId: input.projectId,
      repoPath: input.repoPath,
      mode: input.mode,
      disposition: "skipped",
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
      manualEntries: buildManualEntries({ analysis, captureInput, filesChanged: captureFilesChanged }),
      evidenceEventIds: [capture.evidenceEventId],
      confidenceScore: analysis.confidenceScore,
      confidenceReasons: analysis.confidenceReasons,
      publishingMode,
      autoPublishThreshold: project.autoPublishThreshold,
      sourceCommit: input.commitSha,
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

  return {
    ok: true,
    projectId: input.projectId,
    repoPath: input.repoPath,
    mode: input.mode,
    disposition: "documented",
    capture,
    analysis,
    upsert: { featureId: upsert.featureId, manualEntryIds },
    publish,
  };
}
