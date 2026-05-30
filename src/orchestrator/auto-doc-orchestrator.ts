import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnalyzeDocumentationCandidateResult, Audience, EntryType } from "../types.js";
import { buildNarrativeManualEntries } from "../analysis/narrative-templates.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { getStateStore, type EventSnapshot, type ProjectState } from "../lib/state-store.js";
import { registerCaptureDevelopmentEventTool } from "../tools/capture-development-event.js";
import { registerAnalyzeDocumentationCandidateTool } from "../tools/analyze-documentation-candidate.js";
import { registerGetGitDiffSummaryTool } from "../tools/get-git-diff-summary.js";
import { registerInitializeProjectManualTool } from "../tools/initialize-project-manual.js";
import { registerUpsertFeatureDocumentationTool } from "../tools/upsert-feature-documentation.js";

type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
};

type ToolHandler = (input: unknown) => Promise<ToolCallResult>;

type ToolResponse<T> = T & { traceId: string };

type GitDiffSummaryResponse = {
  mode: "staged" | "last_commit" | "working_tree";
  summary: string;
};

type UpsertResponse = {
  featureId: string;
  featureName: string;
  featureKey: string;
  evidenceEventIds: string[];
  publishing: { status: string; decision: string };
  manualEntries: Array<{ pageId: string; url?: string }>;
};

type CaptureDevelopmentEventResponse = {
  evidenceEventId: string;
  evidencePageId: string;
  initialClassification: "true" | "false" | "uncertain";
};

type InitializeProjectManualResponse = {
  projectId: string;
};

export type AutonomousTriggerInput = {
  projectId: string;
  repoPath?: string;
  mode?: "staged" | "last_commit" | "working_tree";
  source?: EventSnapshot["source"];
  eventType?: EventSnapshot["eventType"];
  summary?: string;
  diffSummary?: string;
  filesChanged?: string[];
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
  testStatus?: EventSnapshot["testStatus"];
  traceId?: string;
};

export type AutonomousTriggerResult = {
  traceId: string;
  projectId: string;
  eventId: string | null;
  status: "no_changes" | "captured_only" | "documented";
  diffSummaryLength: number;
  analyzed: AnalyzeDocumentationCandidateResult | null;
  upserted: UpsertResponse | null;
};

class InMemoryToolHost {
  public readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

function parseToolText<T>(result: ToolCallResult): T {
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("Tool did not return a text payload.");
  }

  return JSON.parse(first.text) as T;
}

function parseFilesChanged(diffSummary: string): string[] {
  const files = new Set<string>();
  const diffGitRegex = /^diff --git a\/[^\s]+ b\/(.+)$/gm;
  const plusPlusRegex = /^\+\+\+ b\/(.+)$/gm;

  let match = diffGitRegex.exec(diffSummary);
  while (match) {
    files.add(match[1]);
    match = diffGitRegex.exec(diffSummary);
  }

  match = plusPlusRegex.exec(diffSummary);
  while (match) {
    files.add(match[1]);
    match = plusPlusRegex.exec(diffSummary);
  }

  return Array.from(files).slice(0, 100);
}

function firstNonEmptyLine(input: string): string {
  const line = input
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);

  return line ?? "Automated documentation trigger captured repository changes.";
}

function toLowerPublishingMode(mode: ProjectState["publishingMode"]): "conservative" | "balanced" | "fully_automatic" {
  if (mode === "Conservative") {
    return "conservative";
  }

  if (mode === "Fully Automatic") {
    return "fully_automatic";
  }

  return "balanced";
}

function normalizeAudiences(audiences: Audience[]): Array<"User" | "Admin" | "Developer" | "Support"> {
  const resolved = new Set<"User" | "Admin" | "Developer" | "Support">();

  for (const audience of audiences) {
    if (audience === "User" || audience === "Admin") {
      resolved.add(audience);
      continue;
    }

    if (audience === "Both") {
      resolved.add("User");
      resolved.add("Admin");
    }
  }

  if (resolved.size === 0) {
    resolved.add("User");
  }

  return Array.from(resolved);
}

function inferEventType(mode: AutonomousTriggerInput["mode"]): EventSnapshot["eventType"] {
  return mode === "last_commit" ? "commit" : "diff";
}

function extractSourceCommit(diffSummary: string): string | undefined {
  const match = diffSummary.match(/\b[0-9a-f]{7,40}\b/i);
  return match?.[0];
}

function buildAutonomousSummary(input: AutonomousTriggerInput, diffSummary: string): string {
  const baseSummary = input.summary?.trim() || firstNonEmptyLine(diffSummary);
  const parts = [baseSummary];

  if (input.prTitle) {
    parts.push(`PR title: ${input.prTitle.trim()}`);
  }

  if (input.prNumber !== undefined) {
    const branchFlow = [input.headBranch ?? input.branch, input.baseBranch].filter(Boolean).join(" -> ");
    parts.push(`Pull request #${input.prNumber}${branchFlow ? ` (${branchFlow})` : ""}`);
  }

  if (input.releaseVersion) {
    parts.push(`Release version: ${input.releaseVersion}`);
  }

  return parts.filter(Boolean).join("\n");
}

function resolveSnapshotFromInput(input: AutonomousTriggerInput, diffSummary: string): EventSnapshot {
  return {
    summary: buildAutonomousSummary(input, diffSummary),
    filesChanged: input.filesChanged && input.filesChanged.length > 0 ? input.filesChanged : parseFilesChanged(diffSummary),
    diffSummary: diffSummary.slice(0, 8000),
    prBody: input.prBody,
    issueReferences: input.issueReferences,
    commitSha: input.commitSha ?? extractSourceCommit(diffSummary),
    branch: input.headBranch ?? input.branch,
    prUrl: input.prUrl,
    prTitle: input.prTitle,
    prNumber: input.prNumber,
    baseBranch: input.baseBranch,
    headBranch: input.headBranch,
    releaseVersion: input.releaseVersion,
    eventType: input.eventType ?? inferEventType(input.mode ?? "working_tree"),
    source: input.source ?? "local_git",
    testStatus: input.testStatus ?? "unknown",
  };
}

export async function executeAutonomousDocumentationTrigger(input: AutonomousTriggerInput): Promise<AutonomousTriggerResult> {
  const traceId = resolveTraceId(input.traceId);
  const startedAt = Date.now();
  const resolvedMode = input.mode ?? "working_tree";
  const resolvedSource = input.source ?? "local_git";

  logToolEvent({
    level: "info",
    tool: "run_autonomous_documentation_trigger",
    stage: "start",
    traceId,
    message: "Running autonomous documentation trigger",
    data: { projectId: input.projectId, mode: resolvedMode, repoPath: input.repoPath, source: resolvedSource },
  });

  const toolHost = new InMemoryToolHost();
  registerCaptureDevelopmentEventTool(toolHost as unknown as McpServer);
  registerGetGitDiffSummaryTool(toolHost as unknown as McpServer);
  registerAnalyzeDocumentationCandidateTool(toolHost as unknown as McpServer);
  registerInitializeProjectManualTool(toolHost as unknown as McpServer);
  registerUpsertFeatureDocumentationTool(toolHost as unknown as McpServer);

  const captureDevelopmentEvent = toolHost.handlers.get("capture_development_event");
  const getGitDiffSummary = toolHost.handlers.get("get_git_diff_summary");
  const analyzeDocumentationCandidate = toolHost.handlers.get("analyze_documentation_candidate");
  const initializeProjectManual = toolHost.handlers.get("initialize_project_manual");
  const upsertFeatureDocumentation = toolHost.handlers.get("upsert_feature_documentation");

  if (!captureDevelopmentEvent || !getGitDiffSummary || !analyzeDocumentationCandidate || !initializeProjectManual || !upsertFeatureDocumentation) {
    throw new Error("Autonomous trigger could not resolve required tool handlers.");
  }

  const resolvedDiffSummary = input.diffSummary?.trim()
    ? input.diffSummary
    : parseToolText<ToolResponse<GitDiffSummaryResponse>>(
        await getGitDiffSummary({ repoPath: input.repoPath, mode: resolvedMode, traceId }),
      ).summary;

  if (resolvedDiffSummary.trim().length === 0) {
    logToolEvent({
      level: "info",
      tool: "run_autonomous_documentation_trigger",
      stage: "success",
      traceId,
      message: "No repository changes detected for autonomous trigger",
      data: { projectId: input.projectId, durationMs: Date.now() - startedAt },
    });

    return {
      traceId,
      projectId: input.projectId,
      eventId: null,
      status: "no_changes",
      diffSummaryLength: 0,
      analyzed: null,
      upserted: null,
    };
  }

  const store = getStateStore();
  let effectiveProjectId = input.projectId;
  let project = await store.getProject(effectiveProjectId);
  if (!project) {
    const aliasProjectId = await store.getBootstrapProjectAlias(input.projectId);
    if (aliasProjectId) {
      const aliasedProject = await store.getProject(aliasProjectId);
      if (aliasedProject) {
        effectiveProjectId = aliasProjectId;
        project = aliasedProject;
      }
    }
  }

  if (!project) {
    const bootstrapParentPageId = process.env.AUTO_DOC_BOOTSTRAP_PARENT_PAGE_ID?.trim();
    if (!bootstrapParentPageId) {
      throw new Error(
        "Unknown projectId. Run initialize_project_manual first or set AUTO_DOC_BOOTSTRAP_PARENT_PAGE_ID for guarded auto-bootstrap.",
      );
    }

    const bootstrapProjectName = process.env.AUTO_DOC_BOOTSTRAP_PROJECT_NAME?.trim() || `Auto-Doc ${input.projectId}`;
    const bootstrapRepositoryUrl = process.env.AUTO_DOC_BOOTSTRAP_REPOSITORY_URL?.trim();

    logToolEvent({
      level: "info",
      tool: "run_autonomous_documentation_trigger",
      stage: "auto_bootstrap_start",
      traceId,
      message: "Project not found; attempting guarded bootstrap",
      data: { requestedProjectId: input.projectId, bootstrapProjectName },
    });

    const bootstrapResult = parseToolText<ToolResponse<InitializeProjectManualResponse>>(
      await initializeProjectManual({
        projectName: bootstrapProjectName,
        parentPageId: bootstrapParentPageId,
        repositoryUrl: bootstrapRepositoryUrl,
        traceId,
      }),
    );

    effectiveProjectId = bootstrapResult.projectId;
    await store.setBootstrapProjectAlias(input.projectId, effectiveProjectId);
    project = await store.getProject(effectiveProjectId);
    if (!project) {
      throw new Error("Auto-bootstrap succeeded but project state was not available for autonomous trigger.");
    }

    logToolEvent({
      level: "info",
      tool: "run_autonomous_documentation_trigger",
      stage: "auto_bootstrap_success",
      traceId,
      message: "Guarded project bootstrap completed",
      data: { requestedProjectId: input.projectId, resolvedProjectId: effectiveProjectId },
    });
  }

  const snapshot = resolveSnapshotFromInput({ ...input, mode: resolvedMode, source: resolvedSource }, resolvedDiffSummary);
  const captureResult = parseToolText<ToolResponse<CaptureDevelopmentEventResponse>>(
    await captureDevelopmentEvent({
      projectId: effectiveProjectId,
      source: snapshot.source,
      eventType: snapshot.eventType,
      summary: snapshot.summary,
      commitSha: snapshot.commitSha,
      branch: snapshot.branch,
      prUrl: snapshot.prUrl,
      prTitle: snapshot.prTitle,
      prBody: snapshot.prBody,
      prNumber: snapshot.prNumber,
      baseBranch: snapshot.baseBranch,
      headBranch: snapshot.headBranch,
      issueReferences: snapshot.issueReferences,
      releaseVersion: snapshot.releaseVersion,
      filesChanged: snapshot.filesChanged.join(","),
      diffSummary: snapshot.diffSummary,
      testStatus: snapshot.testStatus,
      traceId,
    }),
  );
  const eventId = captureResult.evidenceEventId;

  const existingFeatureKeys = Object.keys(project.featuresByKey);
  const analyzed = parseToolText<ToolResponse<AnalyzeDocumentationCandidateResult>>(
    await analyzeDocumentationCandidate({
      projectId: effectiveProjectId,
      evidenceEventIds: [eventId],
      existingFeatureKeys,
      traceId,
    }),
  );

  if (!analyzed.shouldDocument) {
    logToolEvent({
      level: "info",
      tool: "run_autonomous_documentation_trigger",
      stage: "success",
      traceId,
      message: "Autonomous trigger captured evidence but did not produce documentation",
      data: {
        projectId: effectiveProjectId,
        eventId,
        fallbackReasonCode: analyzed.fallbackReasonCode,
        durationMs: Date.now() - startedAt,
      },
    });

    return {
      traceId,
      projectId: effectiveProjectId,
      eventId,
      status: "captured_only",
      diffSummaryLength: resolvedDiffSummary.length,
      analyzed,
      upserted: null,
    };
  }

  const manualEntries = buildNarrativeManualEntries({
    entryTypes: analyzed.entryTypes,
    featureName: analyzed.featureName,
    snapshot,
    generatedNarratives: analyzed.generatedNarratives,
  });
  const upserted = parseToolText<ToolResponse<UpsertResponse>>(
    await upsertFeatureDocumentation({
          projectId: effectiveProjectId,
      featureKey: analyzed.featureKey,
      featureName: analyzed.featureName,
      audiences: normalizeAudiences(analyzed.audiences),
      manualEntries,
      evidenceEventIds: [eventId],
      confidenceScore: analyzed.confidenceScore,
      confidenceReasons: analyzed.confidenceReasons,
      dedupeDecision: analyzed.dedupeDecision,
      matchedExistingFeatureKey: analyzed.matchedExistingFeatureKey ?? undefined,
      publishingMode: toLowerPublishingMode(project.publishingMode),
      autoPublishThreshold: project.autoPublishThreshold,
      sourceCommit: snapshot.commitSha,
      sourcePr: snapshot.prUrl,
      filesChanged: snapshot.filesChanged,
      traceId,
    }),
  );

  logToolEvent({
    level: "info",
    tool: "run_autonomous_documentation_trigger",
    stage: "success",
    traceId,
    message: "Autonomous trigger completed documentation chain",
    data: {
      projectId: effectiveProjectId,
      eventId,
      featureId: upserted.featureId,
      manualEntryCount: upserted.manualEntries.length,
      durationMs: Date.now() - startedAt,
    },
  });

  return {
    traceId,
    projectId: effectiveProjectId,
    eventId,
    status: "documented",
    diffSummaryLength: resolvedDiffSummary.length,
    analyzed,
    upserted,
  };
}
