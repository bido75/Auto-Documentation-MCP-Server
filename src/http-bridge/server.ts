import { createHmac, timingSafeEqual } from "node:crypto";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { getOptionalRuntimeConfig } from "../config.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { validateBifrostRouteConfig } from "../lib/bifrost-route-validation.js";
import type { AnalyzeDocumentationCandidateResult, Audience, EntryType } from "../types.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { runWithRuntimeContext } from "../lib/runtime-context.js";
import { getStateStore, type ProjectState } from "../lib/state-store.js";
import { registerAnalyzeDocumentationCandidateTool } from "../tools/analyze-documentation-candidate.js";
import { registerCaptureDevelopmentEventTool } from "../tools/capture-development-event.js";
import { registerUpsertFeatureDocumentationTool } from "../tools/upsert-feature-documentation.js";
import { createServer, REGISTERED_TOOL_NAMES, SERVER_METADATA } from "../server.js";
import { executeAutonomousDocumentationTrigger, type AutonomousTriggerInput } from "../orchestrator/auto-doc-orchestrator.js";
import { parseContinuousRunnerTargets } from "../runner/index.js";
import { buildCandidate } from "../providers/factory.js";

const DEFAULT_PORT = 3741;
const DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;
const DEFAULT_REPLAY_TTL_MS = 10 * 60 * 1000;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
};

type ToolHandler = (input: unknown) => Promise<ToolCallResult>;

type ToolResponse<T> = T & { traceId: string };

type CaptureResponse = {
  traceId: string;
  evidenceEventId: string;
};

type UpsertResponse = {
  featureId: string;
  manualEntries: Array<{ pageId: string; url?: string }>;
};

type GitHubWebhookEventName = "pull_request" | "pull_request_review" | "issue_comment" | "pull_request_review_comment";

type CaptureToolInput = {
  projectId: string;
  source: "github" | "ai_session";
  eventType: "pr_opened" | "pr_merged" | "session_completed";
  summary: string;
  commitSha?: string;
  branch?: string;
  prUrl?: string;
  prTitle?: string;
  prBody?: string;
  prNumber?: number;
  baseBranch?: string;
  headBranch?: string;
  issueReferences?: string[];
  filesChanged?: string;
  diffSummary?: string;
  testStatus?: "passed" | "failed" | "unknown" | "not_run";
  traceId?: string;
};

export type GitHubWebhookProcessResult = {
  traceId: string;
  projectId: string;
  eventName: string;
  deliveryId: string | null;
  status: "ignored" | "captured_only" | "documented";
  reason?: string;
  evidenceEventId?: string;
  featureId?: string;
  manualEntryCount?: number;
};

export type AiSessionWebhookProcessResult = GitHubWebhookProcessResult;

type ReplayProtector = {
  isReplay: (scope: string, deliveryId: string) => boolean;
};

type FixedWindowRateLimiter = {
  check: (key: string) => { allowed: boolean; retryAfterSeconds: number };
};

type RunnerTriggerRequest = Partial<
  Pick<
  AutonomousTriggerInput,
  | "projectId"
  | "repoPath"
  | "mode"
  | "source"
  | "eventType"
  | "summary"
  | "diffSummary"
  | "filesChanged"
  | "commitSha"
  | "branch"
  | "prUrl"
  | "prTitle"
  | "prBody"
  | "prNumber"
  | "baseBranch"
  | "headBranch"
  | "issueReferences"
  | "releaseVersion"
  | "testStatus"
  | "traceId"
  >
>;

type RunnerStatusTarget = {
  projectId: string;
  repoPath: string;
  mode: "staged" | "last_commit" | "working_tree";
  releaseAutomation: boolean;
  projectConfigured: boolean;
  hasNotionDatabases: boolean;
  lastSeenReleaseTag: string | null;
  latestRunStatus: "success" | "failure" | null;
  latestRunAt: string | null;
  latestRunErrorMessage: string | null;
  failureTriageAcknowledged: boolean;
  failureCooldownUntil: string | null;
};

type StartupPreflightSummary = {
  server: {
    name: string;
    version: string;
    transport: "http-sse";
    host: string;
    port: number;
  };
  runtime: {
    notionTokenPresent: boolean;
    providerType: string;
    providerEndpoint: string;
    fallbackToDeterministic: boolean;
    embeddingProvider: string;
  };
  provider: {
    candidateId: string;
    healthy: boolean;
    bifrostRouteValidation: ReturnType<typeof validateBifrostRouteConfig>;
  };
  runner: {
    configuredTargetCount: number;
    readyTargetCount: number;
    targets: Array<{
      projectId: string;
      repoPath: string;
      projectConfigured: boolean;
      hasNotionDatabases: boolean;
    }>;
  };
  warnings: string[];
  generatedAt: string;
};

class InMemoryToolHost {
  public readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

export function createReplayProtector(input?: {
  ttlMs?: number;
  now?: () => number;
}): ReplayProtector {
  const ttlMs = input?.ttlMs ?? DEFAULT_REPLAY_TTL_MS;
  const now = input?.now ?? (() => Date.now());
  const seen = new Map<string, number>();

  function prune(nowValue: number) {
    for (const [key, expiresAt] of seen.entries()) {
      if (expiresAt <= nowValue) {
        seen.delete(key);
      }
    }
  }

  return {
    isReplay(scope: string, deliveryId: string): boolean {
      const nowValue = now();
      prune(nowValue);
      const key = `${scope}:${deliveryId}`;
      const existing = seen.get(key);
      if (typeof existing === "number" && existing > nowValue) {
        return true;
      }

      seen.set(key, nowValue + ttlMs);
      return false;
    },
  };
}

export function createFixedWindowRateLimiter(input?: {
  limit?: number;
  windowMs?: number;
  now?: () => number;
}): FixedWindowRateLimiter {
  const limit = Math.max(1, input?.limit ?? DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE);
  const windowMs = Math.max(1000, input?.windowMs ?? 60_000);
  const now = input?.now ?? (() => Date.now());
  const buckets = new Map<string, { startedAt: number; count: number }>();

  return {
    check(key: string): { allowed: boolean; retryAfterSeconds: number } {
      const nowValue = now();
      const bucket = buckets.get(key);
      if (!bucket || nowValue - bucket.startedAt >= windowMs) {
        buckets.set(key, { startedAt: nowValue, count: 1 });
        return { allowed: true, retryAfterSeconds: 0 };
      }

      bucket.count += 1;
      if (bucket.count <= limit) {
        return { allowed: true, retryAfterSeconds: 0 };
      }

      const retryMs = Math.max(0, bucket.startedAt + windowMs - nowValue);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
    },
  };
}

function resolveClientIdentity(req: Request): string {
  const forwarded = req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) {
    return forwarded;
  }

  return req.ip || "unknown";
}

function parseToolText<T>(result: ToolCallResult): T {
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("Tool did not return a text payload.");
  }

  return JSON.parse(first.text) as T;
}

function hasRequiredNotionDatabaseIds(project: ProjectState): boolean {
  const db = project.databases;
  return [db.projectsDatabaseId, db.featuresDatabaseId, db.manualEntriesDatabaseId, db.evidenceEventsDatabaseId, db.releasesDatabaseId].every(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function parseRunnerTriggerRequest(payload: unknown): RunnerTriggerRequest {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const input = payload as Record<string, unknown>;
  const filesChanged = Array.isArray(input.filesChanged)
    ? input.filesChanged.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0)
    : undefined;
  const issueReferences = Array.isArray(input.issueReferences)
    ? input.issueReferences.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0)
    : undefined;

  return {
    projectId: typeof input.projectId === "string" ? input.projectId.trim() : undefined,
    repoPath: typeof input.repoPath === "string" ? input.repoPath.trim() : undefined,
    mode: input.mode === "staged" || input.mode === "last_commit" || input.mode === "working_tree" ? input.mode : undefined,
    source:
      input.source === "local_git" ||
      input.source === "github" ||
      input.source === "ci" ||
      input.source === "release" ||
      input.source === "ai_session"
        ? input.source
        : undefined,
    eventType:
      input.eventType === "commit" ||
      input.eventType === "diff" ||
      input.eventType === "pr_opened" ||
      input.eventType === "pr_merged" ||
      input.eventType === "tests_passed" ||
      input.eventType === "release_tagged" ||
      input.eventType === "session_completed"
        ? input.eventType
        : undefined,
    summary: typeof input.summary === "string" ? input.summary : undefined,
    diffSummary: typeof input.diffSummary === "string" ? input.diffSummary : undefined,
    filesChanged,
    commitSha: typeof input.commitSha === "string" ? input.commitSha : undefined,
    branch: typeof input.branch === "string" ? input.branch : undefined,
    prUrl: typeof input.prUrl === "string" ? input.prUrl : undefined,
    prTitle: typeof input.prTitle === "string" ? input.prTitle : undefined,
    prBody: typeof input.prBody === "string" ? input.prBody : undefined,
    prNumber: typeof input.prNumber === "number" ? input.prNumber : undefined,
    baseBranch: typeof input.baseBranch === "string" ? input.baseBranch : undefined,
    headBranch: typeof input.headBranch === "string" ? input.headBranch : undefined,
    issueReferences,
    releaseVersion: typeof input.releaseVersion === "string" ? input.releaseVersion : undefined,
    testStatus: input.testStatus === "passed" || input.testStatus === "failed" || input.testStatus === "unknown" || input.testStatus === "not_run" ? input.testStatus : undefined,
    traceId: typeof input.traceId === "string" ? input.traceId : undefined,
  };
}

function resolveConfiguredRunnerTargets(): { targets: ReturnType<typeof parseContinuousRunnerTargets>; error?: string } {
  try {
    return { targets: parseContinuousRunnerTargets(process.env) };
  } catch (error) {
    return {
      targets: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildRunnerStatusTargets(): Promise<{ targets: RunnerStatusTarget[]; configurationError?: string }> {
  const configured = resolveConfiguredRunnerTargets();
  if (configured.targets.length === 0) {
    return { targets: [], configurationError: configured.error };
  }

  const store = getStateStore();
  const targets: RunnerStatusTarget[] = [];

  for (const target of configured.targets) {
    const [project, lastSeenReleaseTag, runs, triage] = await Promise.all([
      store.getProject(target.projectId),
      store.getLastSeenReleaseTag(target.projectId, target.repoPath),
      store.listReleaseAutomationRuns(target.projectId, target.repoPath),
      store.getRunnerFailureTriageMetadata(target.projectId, target.repoPath),
    ]);

    const latestRun = runs[0] ?? null;
    const projectConfigured = project !== null;

    targets.push({
      projectId: target.projectId,
      repoPath: target.repoPath,
      mode: target.mode ?? "working_tree",
      releaseAutomation: target.releaseAutomation === true,
      projectConfigured,
      hasNotionDatabases: project ? hasRequiredNotionDatabaseIds(project) : false,
      lastSeenReleaseTag,
      latestRunStatus: latestRun?.status ?? null,
      latestRunAt: latestRun?.attemptedAt ?? null,
      latestRunErrorMessage: latestRun?.errorMessage ?? null,
      failureTriageAcknowledged: Boolean(triage?.acknowledgedAt),
      failureCooldownUntil: triage?.cooldownUntil ?? null,
    });
  }

  return { targets, configurationError: configured.error };
}

async function resolveRunnerTriggerInput(request: RunnerTriggerRequest): Promise<AutonomousTriggerInput> {
  const configured = resolveConfiguredRunnerTargets();
  const fallbackTarget = configured.targets[0];

  const projectId = request.projectId?.trim() || fallbackTarget?.projectId;
  const repoPath = request.repoPath?.trim() || fallbackTarget?.repoPath;
  const mode = request.mode ?? fallbackTarget?.mode ?? "working_tree";

  if (!projectId || !repoPath) {
    throw new Error(
      "Runner trigger requires projectId and repoPath in request body, or a configured AUTO_DOC_RUNNER_TARGETS / AUTO_DOC_RUNNER_PROJECT_ID + AUTO_DOC_RUNNER_REPO_PATH.",
    );
  }

  return {
    ...request,
    projectId,
    repoPath,
    mode,
  };
}

async function buildStartupPreflightSummary(host: string, port: number): Promise<StartupPreflightSummary> {
  const runtime = getOptionalRuntimeConfig();
  const warnings: string[] = [];
  let candidateId = "deterministic";
  let healthy = false;

  try {
    const candidate = buildCandidate();
    candidateId = candidate.id;
    healthy = await candidate.healthCheck().catch(() => false);

    if (!healthy) {
      warnings.push(`Provider ${candidate.id} health check failed. Deterministic fallback may be used.`);
    }
  } catch (error) {
    candidateId = "unavailable";
    healthy = false;
    warnings.push(
      `Provider initialization failed: ${error instanceof Error ? error.message : String(error)}. Deterministic fallback may be used.`,
    );
  }

  const runnerStatus = await buildRunnerStatusTargets();
  const bifrostRouteValidation = validateBifrostRouteConfig();

  if (!runtime.notionToken) {
    warnings.push("NOTION_TOKEN is missing. Runtime will require x-notion-token per session.");
  }

  if (runnerStatus.configurationError) {
    warnings.push(`Runner target configuration is invalid: ${runnerStatus.configurationError}`);
  }

  const readyTargetCount = runnerStatus.targets.filter((target) => target.projectConfigured && target.hasNotionDatabases).length;
  if (runnerStatus.targets.length > 0 && readyTargetCount < runnerStatus.targets.length) {
    warnings.push("Some runner targets are not fully initialized (missing project state or Notion database IDs).");
  }

  warnings.push(...bifrostRouteValidation.warnings);

  return {
    server: {
      name: SERVER_METADATA.name,
      version: SERVER_METADATA.version,
      transport: "http-sse",
      host,
      port,
    },
    runtime: {
      notionTokenPresent: Boolean(runtime.notionToken),
      providerType: runtime.provider.type,
      providerEndpoint: runtime.provider.endpoint,
      fallbackToDeterministic: runtime.provider.fallbackToDeterm,
      embeddingProvider: runtime.embedding.provider,
    },
    provider: {
      candidateId,
      healthy,
      bifrostRouteValidation,
    },
    runner: {
      configuredTargetCount: runnerStatus.targets.length,
      readyTargetCount,
      targets: runnerStatus.targets.map((target) => ({
        projectId: target.projectId,
        repoPath: target.repoPath,
        projectConfigured: target.projectConfigured,
        hasNotionDatabases: target.hasNotionDatabases,
      })),
    },
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

function buildBifrostDiscoverabilityContract(host: string, port: number) {
  const baseUrl = `http://${host}:${port}`;
  const bifrostValidation = validateBifrostRouteConfig();

  return {
    name: "auto-doc-mcp-http-sse-contract",
    version: SERVER_METADATA.version,
    baseUrl,
    endpoints: {
      sse: {
        path: "/sse",
        method: "GET",
        expectedStatus: 200,
        notes: "Opens MCP SSE stream. Include x-notion-token header if NOTION_TOKEN is unset.",
      },
      messages: {
        path: "/messages?sessionId={sessionId}",
        method: "POST",
        expectedStatus: 200,
        notes: "Companion endpoint for SSE sessions.",
      },
      health: {
        path: "/health",
        method: "GET",
        expectedStatus: 200,
      },
      info: {
        path: "/info",
        method: "GET",
        expectedStatus: 200,
      },
      runnerStatus: {
        path: "/runner/status",
        method: "GET",
        expectedStatus: 200,
      },
      runnerTrigger: {
        path: "/runner/trigger",
        method: "POST",
        expectedStatus: 200,
      },
      startupPreflight: {
        path: "/startup/preflight",
        method: "GET",
        expectedStatus: 200,
      },
    },
    bifrostGateway: {
      recommendation: "Proxy Bifrost MCP traffic to /sse and /messages while exposing /health and /info for discovery checks.",
      routeValidation: bifrostValidation,
      verificationSteps: [
        `curl ${baseUrl}/health`,
        `curl ${baseUrl}/info`,
        `curl ${baseUrl}/contracts/bifrost-discovery`,
      ],
    },
  };
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

function buildManualEntries(
  entryTypes: EntryType[],
  featureName: string,
  summary: string,
  details: string | undefined,
  sourceLabel: "GitHub webhook" | "AI session webhook",
) {
  const snippet = (details ?? summary).slice(0, 1500);
  const types = entryTypes.length > 0 ? entryTypes : (["Developer Note"] as EntryType[]);

  return types.map((entryType) => {
    const intro = `${sourceLabel} captured updates for ${featureName}.`;

    return {
      entryType,
      title: `${featureName} - ${entryType}`,
      userGuide:
        entryType === "User Guide"
          ? `${intro}\n\nWhat changed:\n${snippet}`
          : `${intro}\n\nNo direct user workflow details were inferred from this signal.`,
      adminGuide:
        entryType === "Admin Guide"
          ? `${intro}\n\nOperational impact:\n${snippet}`
          : `${intro}\n\nNo direct admin workflow details were inferred from this signal.`,
      developerNotes:
        entryType === "Developer Note" || entryType === "Release Note"
          ? `${intro}\n\nCaptured webhook context:\n${snippet}`
          : undefined,
      routes: [],
      apiEndpoints: [],
    };
  });
}

function extractIssueReferences(text?: string): string[] {
  if (!text) {
    return [];
  }

  const matches = text.match(/(?:#|issue\s+#?)(\d{1,6})/gi) ?? [];
  const refs = matches
    .map((value) => value.replace(/^[^\d]+/, "#"))
    .map((value) => value.replace(/issue\s+/i, "#"))
    .filter((value) => value !== "#");

  return Array.from(new Set(refs)).slice(0, 10);
}

function pullRequestActionSummary(action: string): string {
  if (action === "opened") {
    return "Pull request opened";
  }

  if (action === "reopened") {
    return "Pull request reopened";
  }

  if (action === "synchronize") {
    return "Pull request synchronized";
  }

  return "Pull request updated";
}

function parseGitHubEventToCaptureInput(input: {
  projectId: string;
  eventName: string;
  payload: unknown;
  deliveryId?: string;
}): CaptureToolInput | null {
  if (typeof input.payload !== "object" || input.payload === null) {
    return null;
  }

  const payload = input.payload as Record<string, unknown>;
  const deliveryTag = input.deliveryId ? ` Delivery: ${input.deliveryId}.` : "";

  if (input.eventName === "pull_request") {
    const action = typeof payload.action === "string" ? payload.action : "";
    const pr = (payload.pull_request ?? null) as Record<string, unknown> | null;
    if (!pr) {
      return null;
    }

    const number = typeof payload.number === "number" ? payload.number : undefined;
    const title = typeof pr.title === "string" ? pr.title : "GitHub pull request";
    const body = typeof pr.body === "string" ? pr.body : undefined;
    const prUrl = typeof pr.html_url === "string" ? pr.html_url : undefined;
    const merged = pr.merged === true;
    const head = (pr.head ?? null) as Record<string, unknown> | null;
    const base = (pr.base ?? null) as Record<string, unknown> | null;
    const headSha = head && typeof head.sha === "string" ? head.sha : undefined;
    const headRef = head && typeof head.ref === "string" ? head.ref : undefined;
    const baseRef = base && typeof base.ref === "string" ? base.ref : undefined;

    if (action === "closed") {
      if (!merged) {
        return null;
      }

      return {
        projectId: input.projectId,
        source: "github",
        eventType: "pr_merged",
        summary: `Pull request merged: ${title}.${deliveryTag}`,
        commitSha: headSha,
        branch: headRef,
        prUrl,
        prTitle: title,
        prBody: body,
        prNumber: number,
        baseBranch: baseRef,
        headBranch: headRef,
        issueReferences: extractIssueReferences(body),
        diffSummary: `GitHub webhook pull_request action=closed merged=true. ${title}`,
        testStatus: "unknown",
      };
    }

    if (action !== "opened" && action !== "reopened" && action !== "synchronize") {
      return null;
    }

    return {
      projectId: input.projectId,
      source: "github",
      eventType: "pr_opened",
      summary: `${pullRequestActionSummary(action)}: ${title}.${deliveryTag}`,
      commitSha: headSha,
      branch: headRef,
      prUrl,
      prTitle: title,
      prBody: body,
      prNumber: number,
      baseBranch: baseRef,
      headBranch: headRef,
      issueReferences: extractIssueReferences(body),
      diffSummary: `GitHub webhook pull_request action=${action}. ${title}`,
      testStatus: "unknown",
    };
  }

  if (input.eventName === "pull_request_review") {
    const action = typeof payload.action === "string" ? payload.action : "";
    if (action !== "submitted" && action !== "edited" && action !== "dismissed") {
      return null;
    }

    const pr = (payload.pull_request ?? null) as Record<string, unknown> | null;
    if (!pr) {
      return null;
    }

    const review = (payload.review ?? null) as Record<string, unknown> | null;
    const number = typeof payload.number === "number" ? payload.number : undefined;
    const title = typeof pr.title === "string" ? pr.title : "GitHub pull request";
    const prBody = typeof pr.body === "string" ? pr.body : undefined;
    const reviewBody = review && typeof review.body === "string" ? review.body : undefined;
    const reviewState = review && typeof review.state === "string" ? review.state : "commented";
    const prUrl = typeof pr.html_url === "string" ? pr.html_url : undefined;
    const head = (pr.head ?? null) as Record<string, unknown> | null;
    const base = (pr.base ?? null) as Record<string, unknown> | null;
    const headSha = head && typeof head.sha === "string" ? head.sha : undefined;
    const headRef = head && typeof head.ref === "string" ? head.ref : undefined;
    const baseRef = base && typeof base.ref === "string" ? base.ref : undefined;
    const combinedBody = [prBody, reviewBody].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n\n");

    return {
      projectId: input.projectId,
      source: "github",
      eventType: "pr_opened",
      summary: `Pull request review ${reviewState}: ${title}.${deliveryTag}`,
      commitSha: headSha,
      branch: headRef,
      prUrl,
      prTitle: title,
      prBody: combinedBody.length > 0 ? combinedBody : undefined,
      prNumber: number,
      baseBranch: baseRef,
      headBranch: headRef,
      issueReferences: extractIssueReferences(combinedBody),
      diffSummary: `GitHub webhook pull_request_review action=${action} state=${reviewState}. ${title}`,
      testStatus: "unknown",
    };
  }

  if (input.eventName === "issue_comment") {
    const action = typeof payload.action === "string" ? payload.action : "";
    if (action !== "created" && action !== "edited") {
      return null;
    }

    const issue = (payload.issue ?? null) as Record<string, unknown> | null;
    if (!issue) {
      return null;
    }

    const pullRequestRef = (issue.pull_request ?? null) as Record<string, unknown> | null;
    if (!pullRequestRef) {
      return null;
    }

    const comment = (payload.comment ?? null) as Record<string, unknown> | null;
    const issueTitle = typeof issue.title === "string" ? issue.title : "Pull request";
    const issueNumber = typeof issue.number === "number" ? issue.number : undefined;
    const commentBody = comment && typeof comment.body === "string" ? comment.body : undefined;
    const prUrl = typeof issue.html_url === "string" ? issue.html_url : undefined;

    return {
      projectId: input.projectId,
      source: "github",
      eventType: "pr_opened",
      summary: `Pull request comment ${action}: ${issueTitle}.${deliveryTag}`,
      prUrl,
      prTitle: issueTitle,
      prBody: commentBody,
      prNumber: issueNumber,
      issueReferences: extractIssueReferences(commentBody),
      diffSummary: `GitHub webhook issue_comment action=${action}. ${issueTitle}`,
      testStatus: "unknown",
    };
  }

  if (input.eventName === "pull_request_review_comment") {
    const action = typeof payload.action === "string" ? payload.action : "";
    if (action !== "created" && action !== "edited") {
      return null;
    }

    const pr = (payload.pull_request ?? null) as Record<string, unknown> | null;
    if (!pr) {
      return null;
    }

    const comment = (payload.comment ?? null) as Record<string, unknown> | null;
    const title = typeof pr.title === "string" ? pr.title : "GitHub pull request";
    const number = typeof payload.number === "number" ? payload.number : undefined;
    const prUrl = typeof pr.html_url === "string" ? pr.html_url : undefined;
    const body = comment && typeof comment.body === "string" ? comment.body : undefined;

    return {
      projectId: input.projectId,
      source: "github",
      eventType: "pr_opened",
      summary: `Pull request review comment ${action}: ${title}.${deliveryTag}`,
      prUrl,
      prTitle: title,
      prBody: body,
      prNumber: number,
      issueReferences: extractIssueReferences(body),
      diffSummary: `GitHub webhook pull_request_review_comment action=${action}. ${title}`,
      testStatus: "unknown",
    };
  }

  return null;
}

function parseAiSessionEventToCaptureInput(input: {
  projectId: string;
  payload: unknown;
  deliveryId?: string;
}): CaptureToolInput | null {
  if (typeof input.payload !== "object" || input.payload === null) {
    return null;
  }

  const payload = input.payload as Record<string, unknown>;
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  if (!summary) {
    return null;
  }

  const filesChanged = Array.isArray(payload.filesChanged)
    ? payload.filesChanged
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];

  const issueReferences = Array.isArray(payload.issueReferences)
    ? payload.issueReferences
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : extractIssueReferences(typeof payload.diffSummary === "string" ? payload.diffSummary : undefined);

  const deliveryTag = input.deliveryId ? ` Delivery: ${input.deliveryId}.` : "";
  const model = typeof payload.model === "string" ? payload.model : undefined;
  const provider = typeof payload.provider === "string" ? payload.provider : undefined;
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
  const sessionMeta = [sessionId ? `Session: ${sessionId}.` : undefined, model ? `Model: ${model}.` : undefined, provider ? `Provider: ${provider}.` : undefined]
    .filter((item): item is string => typeof item === "string")
    .join(" ");

  return {
    projectId: input.projectId,
    source: "ai_session",
    eventType: "session_completed",
    summary: `${summary}.${deliveryTag}${sessionMeta ? ` ${sessionMeta}` : ""}`,
    commitSha: typeof payload.commitSha === "string" ? payload.commitSha : undefined,
    branch: typeof payload.branch === "string" ? payload.branch : undefined,
    prUrl: typeof payload.prUrl === "string" ? payload.prUrl : undefined,
    prTitle: typeof payload.prTitle === "string" ? payload.prTitle : undefined,
    prBody: typeof payload.prBody === "string" ? payload.prBody : undefined,
    prNumber: typeof payload.prNumber === "number" ? payload.prNumber : undefined,
    baseBranch: typeof payload.baseBranch === "string" ? payload.baseBranch : undefined,
    headBranch: typeof payload.headBranch === "string" ? payload.headBranch : undefined,
    issueReferences,
    filesChanged: filesChanged.length > 0 ? filesChanged.join(",") : undefined,
    diffSummary: typeof payload.diffSummary === "string" ? payload.diffSummary : undefined,
    testStatus:
      payload.testStatus === "passed" ||
      payload.testStatus === "failed" ||
      payload.testStatus === "unknown" ||
      payload.testStatus === "not_run"
        ? payload.testStatus
        : "unknown",
  };
}

async function processCapturedSignal(input: {
  captureInput: CaptureToolInput;
  eventName: string;
  deliveryId?: string;
  traceId?: string;
}): Promise<GitHubWebhookProcessResult> {
  const traceId = resolveTraceId(input.traceId);
  const projectId = input.captureInput.projectId;

  const host = new InMemoryToolHost();
  registerCaptureDevelopmentEventTool(host as unknown as McpServer);
  registerAnalyzeDocumentationCandidateTool(host as unknown as McpServer);
  registerUpsertFeatureDocumentationTool(host as unknown as McpServer);

  const capture = host.handlers.get("capture_development_event");
  const analyze = host.handlers.get("analyze_documentation_candidate");
  const upsert = host.handlers.get("upsert_feature_documentation");

  if (!capture || !analyze || !upsert) {
    throw new Error("Webhook pipeline could not resolve required tool handlers.");
  }

  const store = getStateStore();
  const project = await store.getProject(projectId);
  if (!project) {
    throw new Error("Unknown projectId. Run initialize_project_manual first.");
  }

  const captured = parseToolText<ToolResponse<CaptureResponse>>(
    await capture({
      ...input.captureInput,
      traceId,
    }),
  );

  const existingFeatureKeys = Object.keys(project.featuresByKey);
  const analyzed = parseToolText<ToolResponse<AnalyzeDocumentationCandidateResult>>(
    await analyze({
      projectId,
      evidenceEventIds: [captured.evidenceEventId],
      existingFeatureKeys,
      traceId,
    }),
  );

  if (!analyzed.shouldDocument) {
    return {
      traceId,
      projectId,
      eventName: input.eventName,
      deliveryId: input.deliveryId ?? null,
      status: "captured_only",
      evidenceEventId: captured.evidenceEventId,
      reason: analyzed.fallbackReasonCode,
    };
  }

  const manualEntries = buildManualEntries(
    analyzed.entryTypes,
    analyzed.featureName,
    input.captureInput.summary,
    input.captureInput.diffSummary,
    input.captureInput.source === "ai_session" ? "AI session webhook" : "GitHub webhook",
  );

  const upserted = parseToolText<ToolResponse<UpsertResponse>>(
    await upsert({
      projectId,
      featureKey: analyzed.featureKey,
      featureName: analyzed.featureName,
      audiences: normalizeAudiences(analyzed.audiences),
      manualEntries,
      evidenceEventIds: [captured.evidenceEventId],
      confidenceScore: analyzed.confidenceScore,
      confidenceReasons: analyzed.confidenceReasons,
      dedupeDecision: analyzed.dedupeDecision,
      matchedExistingFeatureKey: analyzed.matchedExistingFeatureKey ?? undefined,
      publishingMode: toLowerPublishingMode(project.publishingMode),
      autoPublishThreshold: project.autoPublishThreshold,
      sourceCommit: input.captureInput.commitSha,
      sourcePr: input.captureInput.prUrl,
      filesChanged: input.captureInput.filesChanged
        ? input.captureInput.filesChanged
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : undefined,
      traceId,
    }),
  );

  return {
    traceId,
    projectId,
    eventName: input.eventName,
    deliveryId: input.deliveryId ?? null,
    status: "documented",
    evidenceEventId: captured.evidenceEventId,
    featureId: upserted.featureId,
    manualEntryCount: upserted.manualEntries.length,
  };
}

export function verifyHmacSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  if (!input.signatureHeader || !input.signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", input.secret).update(input.rawBody).digest("hex")}`;
  const actual = input.signatureHeader;

  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function verifyGitHubWebhookSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  return verifyHmacSignature(input);
}

export function verifyAiSessionWebhookSignature(input: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string;
}): boolean {
  return verifyHmacSignature(input);
}

export async function processGitHubWebhookEvent(input: {
  projectId: string;
  eventName: string;
  payload: unknown;
  deliveryId?: string;
  traceId?: string;
}): Promise<GitHubWebhookProcessResult> {
  const captureInput = parseGitHubEventToCaptureInput({
    projectId: input.projectId,
    eventName: input.eventName,
    payload: input.payload,
    deliveryId: input.deliveryId,
  });

  if (!captureInput) {
    return {
      traceId: resolveTraceId(input.traceId),
      projectId: input.projectId,
      eventName: input.eventName,
      deliveryId: input.deliveryId ?? null,
      status: "ignored",
      reason: "Unsupported GitHub webhook event or action.",
    };
  }

  return processCapturedSignal({
    captureInput,
    eventName: input.eventName,
    deliveryId: input.deliveryId,
    traceId: input.traceId,
  });
}

export async function processAiSessionWebhookEvent(input: {
  projectId: string;
  payload: unknown;
  deliveryId?: string;
  traceId?: string;
}): Promise<AiSessionWebhookProcessResult> {
  const captureInput = parseAiSessionEventToCaptureInput({
    projectId: input.projectId,
    payload: input.payload,
    deliveryId: input.deliveryId,
  });

  if (!captureInput) {
    return {
      traceId: resolveTraceId(input.traceId),
      projectId: input.projectId,
      eventName: "ai_session",
      deliveryId: input.deliveryId ?? null,
      status: "ignored",
      reason: "Unsupported AI session payload.",
    };
  }

  return processCapturedSignal({
    captureInput,
    eventName: "ai_session",
    deliveryId: input.deliveryId,
    traceId: input.traceId,
  });
}

export async function startHttpBridge(options?: { port?: number; host?: string }): Promise<void> {
  const app = express();
  const envPortRaw = process.env.AUTO_DOC_HTTP_PORT?.trim();
  const envPort = envPortRaw ? Number.parseInt(envPortRaw, 10) : NaN;
  const port = options?.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT);
  const host = options?.host ?? (process.env.AUTO_DOC_HTTP_HOST?.trim() || "127.0.0.1");
  const replayProtector = createReplayProtector({
    ttlMs: Number(process.env.WEBHOOK_REPLAY_TTL_MS ?? DEFAULT_REPLAY_TTL_MS),
  });
  const rateLimiter = createFixedWindowRateLimiter({
    limit: Number(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? DEFAULT_WEBHOOK_RATE_LIMIT_PER_MINUTE),
  });

  const transports: Record<string, SSEServerTransport> = {};
  const sessionNotionTokens: Record<string, string> = {};

  const allowedOrigins = getOptionalRuntimeConfig().corsAllowedOrigins;

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.some((allowedOrigin) => origin.startsWith(allowedOrigin))) {
          callback(null, true);
          return;
        }

        callback(new Error(`CORS blocked: ${origin}`));
      },
      credentials: true,
    }),
  );

  app.post("/webhooks/github", express.raw({ type: "application/json", limit: "1mb" }), async (req: Request, res: Response) => {
    const rate = rateLimiter.check(`github:${resolveClientIdentity(req)}`);
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSeconds));
      res.status(429).json({
        ok: false,
        error: "Rate limit exceeded for GitHub webhook endpoint.",
        retryAfterSeconds: rate.retryAfterSeconds,
      });
      return;
    }

    const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (!secret) {
      res.status(503).json({
        ok: false,
        error: "Missing GITHUB_WEBHOOK_SECRET. Configure webhook verification before enabling ingestion.",
      });
      return;
    }

    const signatureHeader = req.header("x-hub-signature-256")?.trim();
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("", "utf8");
    if (!verifyGitHubWebhookSignature({ rawBody, signatureHeader, secret })) {
      res.status(401).json({ ok: false, error: "Invalid webhook signature." });
      return;
    }

    const eventName = req.header("x-github-event")?.trim();
    if (!eventName) {
      res.status(400).json({ ok: false, error: "Missing x-github-event header." });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ ok: false, error: "Invalid JSON webhook payload." });
      return;
    }

    if (eventName === "ping") {
      res.status(200).json({ ok: true, status: "ignored", reason: "GitHub ping" });
      return;
    }

    const deliveryId = req.header("x-github-delivery")?.trim();
    if (!deliveryId) {
      res.status(400).json({ ok: false, error: "Missing x-github-delivery header." });
      return;
    }

    if (replayProtector.isReplay("github", deliveryId)) {
      res.status(202).json({
        ok: true,
        status: "ignored",
        reason: "Duplicate delivery ignored.",
        deliveryId,
      });
      return;
    }

    const projectId =
      (typeof req.query.projectId === "string" && req.query.projectId.trim().length > 0
        ? req.query.projectId.trim()
        : undefined) ??
      req.header("x-auto-doc-project-id")?.trim() ??
      (typeof (payload as Record<string, unknown>).projectId === "string"
        ? ((payload as Record<string, unknown>).projectId as string).trim()
        : "");

    if (!projectId) {
      res.status(400).json({
        ok: false,
        error: "Missing projectId. Provide query ?projectId=..., x-auto-doc-project-id header, or payload.projectId.",
      });
      return;
    }

    try {
      const processed = await processGitHubWebhookEvent({
        projectId,
        eventName,
        payload,
        deliveryId,
      });

      res.status(200).json({ ok: true, ...processed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        ok: false,
        error: "Failed to process GitHub webhook event.",
        details: message,
      });
    }
  });

  app.post("/webhooks/ai-session", express.raw({ type: "application/json", limit: "1mb" }), async (req: Request, res: Response) => {
    const rate = rateLimiter.check(`ai-session:${resolveClientIdentity(req)}`);
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfterSeconds));
      res.status(429).json({
        ok: false,
        error: "Rate limit exceeded for AI session webhook endpoint.",
        retryAfterSeconds: rate.retryAfterSeconds,
      });
      return;
    }

    const secret = process.env.AI_SESSION_WEBHOOK_SECRET?.trim();
    if (!secret) {
      res.status(503).json({
        ok: false,
        error: "Missing AI_SESSION_WEBHOOK_SECRET. Configure webhook verification before enabling ingestion.",
      });
      return;
    }

    const signatureHeader = req.header("x-auto-doc-signature-256")?.trim();
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("", "utf8");
    if (!verifyAiSessionWebhookSignature({ rawBody, signatureHeader, secret })) {
      res.status(401).json({ ok: false, error: "Invalid webhook signature." });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ ok: false, error: "Invalid JSON webhook payload." });
      return;
    }

    const deliveryId =
      req.header("x-auto-doc-delivery")?.trim() ??
      (typeof (payload as Record<string, unknown>).deliveryId === "string"
        ? ((payload as Record<string, unknown>).deliveryId as string).trim()
        : "");

    if (!deliveryId) {
      res.status(400).json({ ok: false, error: "Missing delivery id. Provide x-auto-doc-delivery header or payload.deliveryId." });
      return;
    }

    if (replayProtector.isReplay("ai-session", deliveryId)) {
      res.status(202).json({
        ok: true,
        status: "ignored",
        reason: "Duplicate delivery ignored.",
        deliveryId,
      });
      return;
    }

    const projectId =
      (typeof req.query.projectId === "string" && req.query.projectId.trim().length > 0
        ? req.query.projectId.trim()
        : undefined) ??
      req.header("x-auto-doc-project-id")?.trim() ??
      (typeof (payload as Record<string, unknown>).projectId === "string"
        ? ((payload as Record<string, unknown>).projectId as string).trim()
        : "");

    if (!projectId) {
      res.status(400).json({
        ok: false,
        error: "Missing projectId. Provide query ?projectId=..., x-auto-doc-project-id header, or payload.projectId.",
      });
      return;
    }

    try {
      const processed = await processAiSessionWebhookEvent({
        projectId,
        payload,
        deliveryId,
      });

      res.status(200).json({ ok: true, ...processed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        ok: false,
        error: "Failed to process AI session webhook event.",
        details: message,
      });
    }
  });

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({
      status: "running",
      server: SERVER_METADATA.name,
      transport: "http-sse",
      version: SERVER_METADATA.version,
    });
  });

  app.get("/info", (_req, res) => {
    res.json({
      name: SERVER_METADATA.name,
      description: "Auto-Documentation MCP Server - writes Notion manuals silently as you code",
      version: SERVER_METADATA.version,
      transport: "http-sse",
      endpoints: {
        health: "/health",
        info: "/info",
        sse: "/sse",
        messages: "/messages",
        githubWebhook: "/webhooks/github",
        aiSessionWebhook: "/webhooks/ai-session",
        runnerStatus: "/runner/status",
        runnerTrigger: "/runner/trigger",
        startupPreflight: "/startup/preflight",
        bifrostDiscoveryContract: "/contracts/bifrost-discovery",
      },
      tools: REGISTERED_TOOL_NAMES,
    });
  });

  app.get("/runner/status", async (_req, res) => {
    try {
      const { targets, configurationError } = await buildRunnerStatusTargets();
      res.json({
        runtimeMode: process.env.AUTO_DOC_RUNTIME_MODE?.trim() || "mcp",
        targetCount: targets.length,
        configurationError: configurationError ?? null,
        targets,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        ok: false,
        error: "Failed to build runner status.",
        details: message,
      });
    }
  });

  app.post("/runner/trigger", async (req: Request, res: Response) => {
    try {
      const requested = parseRunnerTriggerRequest(req.body);
      const triggerInput = await resolveRunnerTriggerInput(requested);
      const result = await executeAutonomousDocumentationTrigger(triggerInput);
      res.status(200).json({
        ok: true,
        triggerInput: {
          projectId: triggerInput.projectId,
          repoPath: triggerInput.repoPath,
          mode: triggerInput.mode,
        },
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({
        ok: false,
        error: "Failed to run on-demand documentation trigger.",
        details: message,
      });
    }
  });

  app.get("/startup/preflight", async (_req, res) => {
    try {
      const summary = await buildStartupPreflightSummary(host, port);
      res.json(summary);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        ok: false,
        error: "Failed to generate startup preflight summary.",
        details: message,
      });
    }
  });

  app.get("/contracts/bifrost-discovery", (_req, res) => {
    res.json(buildBifrostDiscoverabilityContract(host, port));
  });

  app.post("/mcp", (req: Request, res: Response) => {
    const payload = req.body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> } | undefined;
    const method = payload?.method;
    const requestId = payload?.id ?? null;

    if (method === "tools/list") {
      res.status(200).json({
        jsonrpc: "2.0",
        id: requestId,
        result: {
          tools: REGISTERED_TOOL_NAMES.map((name) => ({ name })),
          transport: "http-sse",
          message: "Use GET /sse then POST /messages?sessionId={sessionId} for full MCP tool calls.",
        },
      });
      return;
    }

    if (method === "tools/call") {
      res.status(400).json({
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: -32600,
          message: "Direct tools/call over /mcp is not supported. Establish an SSE session via GET /sse and POST to /messages?sessionId={sessionId}.",
        },
      });
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      id: requestId,
      error: {
        code: -32600,
        message:
          "Unsupported /mcp request. Use method tools/list for discovery or connect through GET /sse and POST /messages?sessionId={sessionId}.",
      },
    });
  });

  app.get("/sse", async (req: Request, res: Response) => {
    const headerToken = req.header("x-notion-token")?.trim();
    const envToken = process.env.NOTION_TOKEN?.trim();
    const sessionToken = headerToken && headerToken.length > 0 ? headerToken : envToken;
    const allowUnauthenticatedSse = isTruthyEnv(process.env.AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE);

    if ((!sessionToken || sessionToken.length === 0) && !allowUnauthenticatedSse) {
      res.status(401).json({
        ok: false,
        error: "Missing Notion token. Provide x-notion-token, set NOTION_TOKEN, or enable AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE=true for local tool discovery.",
      });
      return;
    }

    const resolvedSessionToken = sessionToken && sessionToken.length > 0 ? sessionToken : "";

    const transport = new SSEServerTransport("/messages", res);
    const sessionId = transport.sessionId;
    transports[sessionId] = transport;
    sessionNotionTokens[sessionId] = resolvedSessionToken;
    transport.onclose = () => {
      delete transports[sessionId];
      delete sessionNotionTokens[sessionId];
    };

    const server = createServer();
    await runWithRuntimeContext({ notionToken: resolvedSessionToken }, async () => {
      await server.connect(transport);
    });
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId;
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      res.status(400).send("Missing sessionId parameter");
      return;
    }

    const transport = transports[sessionId];
    if (!transport) {
      res.status(404).send("Session not found");
      return;
    }

    const sessionNotionToken = sessionNotionTokens[sessionId];
    await runWithRuntimeContext({ notionToken: sessionNotionToken }, async () => {
      await transport.handlePostMessage(req, res, req.body);
    });
  });

  await new Promise<void>((resolve) => {
    app.listen(port, host, () => {
      console.error(`Auto-Doc MCP HTTP bridge running on http://${host}:${port}`);
      console.error(`Connect web tools to http://${host}:${port}/sse`);
      void buildStartupPreflightSummary(host, port)
        .then((summary) => {
          logToolEvent({
            level: summary.warnings.length > 0 ? "warn" : "info",
            tool: "http_bridge",
            stage: "startup_preflight_summary",
            traceId: resolveTraceId(),
            message: "HTTP bridge startup preflight summary generated.",
            data: summary,
          });
        })
        .catch((error) => {
          logToolEvent({
            level: "error",
            tool: "http_bridge",
            stage: "startup_preflight_failure",
            traceId: resolveTraceId(),
            message: "Failed to generate HTTP bridge startup preflight summary.",
            data: { error: error instanceof Error ? error.message : String(error) },
          });
        });
      resolve();
    });
  });
}
