import { fileURLToPath } from "node:url";
import { getOptionalRuntimeConfig, getRuntimeConfig } from "../config.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import {
  ContinuousDocumentationRunner,
  type ContinuousRunnerConfig,
  type ContinuousRunnerTarget,
} from "./continuous-documentation-runner.js";

type RunnerEnvironment = NodeJS.ProcessEnv;

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

function parsePollIntervalMs(env: RunnerEnvironment): number {
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

function parseTarget(candidate: unknown, index: number): ContinuousRunnerTarget {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}] must be an object.`);
  }

  const target = candidate as Record<string, unknown>;
  const projectId = typeof target.projectId === "string" ? target.projectId.trim() : "";
  const repoPath = typeof target.repoPath === "string" ? target.repoPath.trim() : "";
  const mode = target.mode;
  const parsedMode: ContinuousRunnerTarget["mode"] | undefined =
    mode === undefined ? undefined : mode === "staged" || mode === "last_commit" || mode === "working_tree" ? mode : undefined;
  const releaseAutomation =
    target.releaseAutomation === undefined
      ? undefined
      : typeof target.releaseAutomation === "boolean"
        ? target.releaseAutomation
        : undefined;
  const releasePrUrl = typeof target.releasePrUrl === "string" ? target.releasePrUrl.trim() : undefined;
  const releaseAudience =
    target.releaseAudience === "user" || target.releaseAudience === "admin" || target.releaseAudience === "both"
      ? target.releaseAudience
      : undefined;
  const releasePackageFormat =
    target.releasePackageFormat === "notion_page" || target.releasePackageFormat === "markdown"
      ? target.releasePackageFormat
      : undefined;
  const releasePdfOutputPath = typeof target.releasePdfOutputPath === "string" ? target.releasePdfOutputPath.trim() : undefined;
  const releaseLocalDocsOutputPath =
    typeof target.releaseLocalDocsOutputPath === "string" ? target.releaseLocalDocsOutputPath.trim() : undefined;
  const releaseHelpCenterOutputPath =
    typeof target.releaseHelpCenterOutputPath === "string" ? target.releaseHelpCenterOutputPath.trim() : undefined;

  if (!projectId) {
    throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].projectId is required.`);
  }

  if (!repoPath) {
    throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].repoPath is required.`);
  }

  if (mode !== undefined && parsedMode === undefined) {
    throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].mode must be staged, last_commit, or working_tree.`);
  }

  if (target.releaseAutomation !== undefined && releaseAutomation === undefined) {
    throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].releaseAutomation must be a boolean.`);
  }

  if (target.releaseAudience !== undefined && releaseAudience === undefined) {
    throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].releaseAudience must be user, admin, or both.`);
  }

  if (target.releasePackageFormat !== undefined && releasePackageFormat === undefined) {
    throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].releasePackageFormat must be notion_page or markdown.`);
  }

  if (target.releasePrUrl !== undefined && !releasePrUrl) {
    throw new Error(`AUTO_DOC_RUNNER_TARGETS[${index}].releasePrUrl must be a non-empty string when provided.`);
  }

  return {
    projectId,
    repoPath,
    ...(parsedMode ? { mode: parsedMode } : {}),
    ...(releaseAutomation !== undefined ? { releaseAutomation } : {}),
    ...(releasePrUrl ? { releasePrUrl } : {}),
    ...(releaseAudience ? { releaseAudience } : {}),
    ...(releasePackageFormat ? { releasePackageFormat } : {}),
    ...(releasePdfOutputPath ? { releasePdfOutputPath } : {}),
    ...(releaseLocalDocsOutputPath ? { releaseLocalDocsOutputPath } : {}),
    ...(releaseHelpCenterOutputPath ? { releaseHelpCenterOutputPath } : {}),
  };
}

export function parseContinuousRunnerTargets(env: RunnerEnvironment = process.env): ContinuousRunnerTarget[] {
  const configuredTargets = env.AUTO_DOC_RUNNER_TARGETS?.trim();
  if (configuredTargets) {
    const parsedTargets = JSON.parse(configuredTargets) as unknown;
    if (!Array.isArray(parsedTargets) || parsedTargets.length === 0) {
      throw new Error("AUTO_DOC_RUNNER_TARGETS must be a non-empty JSON array.");
    }

    return parsedTargets.map(parseTarget);
  }

  const projectId = env.AUTO_DOC_RUNNER_PROJECT_ID?.trim();
  const repoPath = env.AUTO_DOC_RUNNER_REPO_PATH?.trim();
  const mode = env.AUTO_DOC_RUNNER_MODE?.trim();
  const parsedMode: ContinuousRunnerTarget["mode"] | undefined =
    mode === undefined ? undefined : mode === "staged" || mode === "last_commit" || mode === "working_tree" ? mode : undefined;
  const releaseAutomation = parseBoolean(env.AUTO_DOC_RUNNER_RELEASE_AUTOMATION);
  const releaseAudienceRaw = env.AUTO_DOC_RUNNER_RELEASE_AUDIENCE?.trim();
  const releaseAudience: ContinuousRunnerTarget["releaseAudience"] | undefined =
    releaseAudienceRaw === "user" || releaseAudienceRaw === "admin" || releaseAudienceRaw === "both" ? releaseAudienceRaw : undefined;
  const releasePackageFormatRaw = env.AUTO_DOC_RUNNER_RELEASE_PACKAGE_FORMAT?.trim();
  const releasePackageFormat: ContinuousRunnerTarget["releasePackageFormat"] | undefined =
    releasePackageFormatRaw === "notion_page" || releasePackageFormatRaw === "markdown" ? releasePackageFormatRaw : undefined;
  const releasePrUrl = env.AUTO_DOC_RUNNER_RELEASE_PR_URL?.trim() || undefined;
  const releasePdfOutputPath = env.AUTO_DOC_RUNNER_RELEASE_PDF_OUTPUT_PATH?.trim() || undefined;
  const releaseLocalDocsOutputPath = env.AUTO_DOC_RUNNER_RELEASE_LOCAL_DOCS_OUTPUT_PATH?.trim() || undefined;
  const releaseHelpCenterOutputPath = env.AUTO_DOC_RUNNER_RELEASE_HELP_CENTER_OUTPUT_PATH?.trim() || undefined;

  if (!projectId || !repoPath) {
    throw new Error(
      "Provide AUTO_DOC_RUNNER_TARGETS or both AUTO_DOC_RUNNER_PROJECT_ID and AUTO_DOC_RUNNER_REPO_PATH.",
    );
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

  return [
    {
      projectId,
      repoPath,
      ...(parsedMode ? { mode: parsedMode } : {}),
      ...(releaseAutomation !== undefined ? { releaseAutomation } : {}),
      ...(releasePrUrl ? { releasePrUrl } : {}),
      ...(releaseAudience ? { releaseAudience } : {}),
      ...(releasePackageFormat ? { releasePackageFormat } : {}),
      ...(releasePdfOutputPath ? { releasePdfOutputPath } : {}),
      ...(releaseLocalDocsOutputPath ? { releaseLocalDocsOutputPath } : {}),
      ...(releaseHelpCenterOutputPath ? { releaseHelpCenterOutputPath } : {}),
    },
  ];
}

export function parseContinuousRunnerConfig(env: RunnerEnvironment = process.env): ContinuousRunnerConfig {
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

export async function runContinuousDocumentationRunner(env: RunnerEnvironment = process.env): Promise<void> {
  const config = parseContinuousRunnerConfig(env);
  const traceId = resolveTraceId(config.traceId);
  const runner = new ContinuousDocumentationRunner({ ...config, traceId });

  let stopped = false;
  let resolveShutdown: (() => void) | null = null;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const stopRunner = async (signal?: string) => {
    if (stopped) {
      return;
    }

    stopped = true;
    logToolEvent({
      level: "info",
      tool: "continuous_documentation_runner_entrypoint",
      stage: "shutdown",
      traceId,
      message: signal ? `Stopping continuous runner after ${signal}.` : "Stopping continuous runner.",
      data: { signal },
    });

    try {
      await runner.stop();
    } finally {
      resolveShutdown?.();
    }
  };

  const handleSignal = (signal: string) => {
    void stopRunner(signal).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logToolEvent({
        level: "error",
        tool: "continuous_documentation_runner_entrypoint",
        stage: "shutdown_failure",
        traceId,
        message: "Failed to stop the continuous runner cleanly.",
        data: { signal, error: message },
      });
      process.exitCode = 1;
      resolveShutdown?.();
    });
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  logToolEvent({
    level: "info",
    tool: "continuous_documentation_runner_entrypoint",
    stage: "start",
    traceId,
    message: "Starting continuous documentation runner.",
    data: { pollIntervalMs: config.pollIntervalMs, targetCount: config.targets.length },
  });

  await runner.start();
  await shutdown;
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