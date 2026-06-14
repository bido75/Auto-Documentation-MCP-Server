import { fileURLToPath } from "node:url";
import { getOptionalRuntimeConfig, getRuntimeConfig } from "../config.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { ContinuousDocumentationRunner } from "./continuous-documentation-runner.js";

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return undefined;
}

function parsePollIntervalMs(env: NodeJS.ProcessEnv): number {
  const rawPollIntervalMs = env.AUTO_DOC_RUNNER_POLL_INTERVAL_MS?.trim() ?? env.RUNNER_TICK_MS?.trim();
  if (!rawPollIntervalMs) {
    return getOptionalRuntimeConfig(env).runner.tickIntervalMs;
  }

  const parsed = Number(rawPollIntervalMs);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("AUTO_DOC_RUNNER_POLL_INTERVAL_MS / RUNNER_TICK_MS must be a positive integer.");
  }

  return parsed;
}

type RunnerTarget = {
  projectId: string;
  repoPath: string;
  mode?: "staged" | "last_commit" | "working_tree";
  releaseAutomation?: boolean;
  releasePrUrl?: string;
  releaseAudience?: "user" | "admin" | "both";
  releasePackageFormat?: "notion_page" | "markdown";
  releasePdfOutputPath?: string;
  releaseLocalDocsOutputPath?: string;
  releaseHelpCenterOutputPath?: string;
};

function parseTarget(candidate: unknown, index: number): RunnerTarget {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}] must be an object.`);
  }

  const target = candidate as Record<string, unknown>;
  const projectId = typeof target.projectId === "string" ? target.projectId.trim() : "";
  const repoPath = typeof target.repoPath === "string" ? target.repoPath.trim() : "";
  const mode = target.mode;
  const parsedMode = mode === undefined ? undefined : mode === "staged" || mode === "last_commit" || mode === "working_tree" ? mode : undefined;
  const releaseAutomation = target.releaseAutomation === undefined ? undefined : typeof target.releaseAutomation === "boolean" ? target.releaseAutomation : undefined;
  const releasePrUrl = typeof target.releasePrUrl === "string" ? target.releasePrUrl.trim() : undefined;
  const releaseAudience = target.releaseAudience === "user" || target.releaseAudience === "admin" || target.releaseAudience === "both" ? target.releaseAudience : undefined;
  const releasePackageFormat = target.releasePackageFormat === "notion_page" || target.releasePackageFormat === "markdown" ? target.releasePackageFormat : undefined;

  if (!projectId) throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].projectId is required.`);
  if (!repoPath) throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].repoPath is required.`);
  if (mode !== undefined && parsedMode === undefined) throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].mode must be staged, last_commit, or working_tree.`);
  if (target.releaseAutomation !== undefined && releaseAutomation === undefined) throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].releaseAutomation must be a boolean.`);
  if (target.releaseAudience !== undefined && releaseAudience === undefined) throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].releaseAudience must be user, admin, or both.`);
  if (target.releasePackageFormat !== undefined && releasePackageFormat === undefined) throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].releasePackageFormat must be notion_page or markdown.`);
  if (target.releasePrUrl !== undefined && !releasePrUrl) throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].releasePrUrl must be a non-empty string when provided.`);

  return {
    projectId,
    repoPath,
    ...(parsedMode ? { mode: parsedMode } : {}),
    ...(releaseAutomation !== undefined ? { releaseAutomation } : {}),
    ...(releasePrUrl ? { releasePrUrl } : {}),
    ...(releaseAudience ? { releaseAudience } : {}),
    ...(releasePackageFormat ? { releasePackageFormat } : {}),
  };
}

function buildSelfDocTarget(env: NodeJS.ProcessEnv): RunnerTarget | null {
  const projectId = env.SELF_DOC_PROJECT_ID?.trim();
  const repoPath = env.SELF_DOC_REPO_PATH?.trim();
  if (!projectId || !repoPath) {
    return null;
  }

  const mode = env.SELF_DOC_RUNNER_MODE?.trim();
  const parsedMode = mode === "staged" || mode === "last_commit" || mode === "working_tree" ? mode : "last_commit";
  return { projectId, repoPath, mode: parsedMode };
}

function appendSelfDocTarget(targets: RunnerTarget[], env: NodeJS.ProcessEnv): RunnerTarget[] {
  const selfDocTarget = buildSelfDocTarget(env);
  if (!selfDocTarget) return targets;
  const exists = targets.some((target) => target.projectId === selfDocTarget.projectId && target.repoPath === selfDocTarget.repoPath);
  if (!exists) targets.push(selfDocTarget);
  return targets;
}

export function parseContinuousRunnerTargets(env = process.env): RunnerTarget[] {
  const configuredTargets = env.AUTO_DOC_RUNNER_TARGETS?.trim();
  if (configuredTargets) {
    const parsedTargets = JSON.parse(configuredTargets) as unknown[];
    if (!Array.isArray(parsedTargets) || parsedTargets.length === 0) {
      throw new Error("AUTO_DOC_RUNNER_TARGETS must be a non-empty JSON array.");
    }
    return appendSelfDocTarget(parsedTargets.map(parseTarget), env);
  }

  const projectId = env.AUTO_DOC_RUNNER_PROJECT_ID?.trim();
  const repoPath = env.AUTO_DOC_RUNNER_REPO_PATH?.trim();
  const mode = env.AUTO_DOC_RUNNER_MODE?.trim();
  const parsedMode = mode === undefined ? undefined : mode === "staged" || mode === "last_commit" || mode === "working_tree" ? mode : undefined;
  const releaseAutomation = parseBoolean(env.AUTO_DOC_RUNNER_RELEASE_AUTOMATION);
  const releaseAudienceRaw = env.AUTO_DOC_RUNNER_RELEASE_AUDIENCE?.trim();
  const releaseAudience = releaseAudienceRaw === "user" || releaseAudienceRaw === "admin" || releaseAudienceRaw === "both" ? releaseAudienceRaw : undefined;
  const releasePackageFormatRaw = env.AUTO_DOC_RUNNER_RELEASE_PACKAGE_FORMAT?.trim();
  const releasePackageFormat = releasePackageFormatRaw === "notion_page" || releasePackageFormatRaw === "markdown" ? releasePackageFormatRaw : undefined;
  const releasePrUrl = env.AUTO_DOC_RUNNER_RELEASE_PR_URL?.trim() || undefined;

  if (!projectId || !repoPath) {
    const selfDocOnlyTarget = buildSelfDocTarget(env);
    if (selfDocOnlyTarget) {
      return [selfDocOnlyTarget];
    }
    throw new Error("Provide AUTO_DOC_RUNNER_TARGETS or both AUTO_DOC_RUNNER_PROJECT_ID and AUTO_DOC_RUNNER_REPO_PATH.");
  }

  if (mode && parsedMode === undefined) {
    throw new Error("AUTO_DOC_RUNNER_MODE must be staged, last_commit, or working_tree.");
  }
  if (env.AUTO_DOC_RUNNER_RELEASE_AUTOMATION !== undefined && releaseAutomation === undefined) {
    throw new Error("AUTO_DOC_RUNNER_RELEASE_AUTOMATION must be true or false.");
  }
  if (releaseAudienceRaw && !releaseAudience) {
    throw new Error("AUTO_DOC_RUNNER_RELEASE_AUDIENCE must be user, admin, or both.");
  }
  if (releasePackageFormatRaw && !releasePackageFormat) {
    throw new Error("AUTO_DOC_RUNNER_RELEASE_PACKAGE_FORMAT must be notion_page or markdown.");
  }

  return appendSelfDocTarget([
    {
      projectId,
      repoPath,
      ...(parsedMode ? { mode: parsedMode } : {}),
      ...(releaseAutomation !== undefined ? { releaseAutomation } : {}),
      ...(releasePrUrl ? { releasePrUrl } : {}),
      ...(releaseAudience ? { releaseAudience } : {}),
      ...(releasePackageFormat ? { releasePackageFormat } : {}),
    },
  ], env);
}

export function parseContinuousRunnerConfig(env = process.env) {
  getRuntimeConfig(env);
  const runtime = getOptionalRuntimeConfig(env);
  return {
    pollIntervalMs: parsePollIntervalMs(env),
    targets: parseContinuousRunnerTargets(env),
    maxConcurrentTargets: runtime.runner.maxConcurrentTargets,
    maxConsecutiveFailures: runtime.runner.maxConsecutiveFailures,
    circuitResetAfterMs: runtime.runner.circuitResetAfterMs,
    perTargetTimeoutMs: runtime.runner.perTargetTimeoutMs,
    traceId: env.AUTO_DOC_RUNNER_TRACE_ID?.trim() || undefined,
  };
}

export async function runContinuousDocumentationRunner(env = process.env): Promise<ContinuousDocumentationRunner> {
  const config = parseContinuousRunnerConfig(env);
  const traceId = resolveTraceId(config.traceId);
  const runner = new ContinuousDocumentationRunner(config);

  const stopRunner = () => {
    void runner.stop().finally(() => {
      process.exitCode = process.exitCode ?? 0;
    });
  };

  process.once("SIGINT", stopRunner);
  process.once("SIGTERM", stopRunner);

  logToolEvent({
    level: "info",
    tool: "continuous_documentation_runner_entrypoint",
    stage: "start",
    traceId,
    message: "Starting continuous documentation runner.",
    data: { pollIntervalMs: config.pollIntervalMs, targetCount: config.targets.length },
  });
  await runner.start();
  return runner;
}

const isExecutedDirectly = fileURLToPath(import.meta.url) === process.argv[1];
if (isExecutedDirectly) {
  void runContinuousDocumentationRunner().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logToolEvent({
      level: "error",
      tool: "continuous_documentation_runner_entrypoint",
      stage: "startup_failure",
      traceId: resolveTraceId(),
      message: "Failed to start the continuous runner.",
      data: { error: message },
    });
    process.exitCode = 1;
  });
}
