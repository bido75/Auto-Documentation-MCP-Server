import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { logToolEvent, redactJsonValue, resolveTraceId } from "./logger.js";
import { resolveStateStorePath } from "./state-store.js";

export type RunnerHealthStatus = "healthy" | "degraded" | "failing";

export type RunnerFailureMode =
  | "degraded_to_deterministic"
  | "zero_authored_threshold"
  | "provider_output_invalid_threshold"
  | "project_missing_from_state"
  | "project_discovery_failed"
  | "runner_liveness_stale"
  | "runner_tick_failure_threshold";

export type RunnerAlertSeverity = "warning" | "critical";

export interface RunnerAlertEvent {
  id: string;
  emittedAt: string;
  failureMode: RunnerFailureMode;
  severity: RunnerAlertSeverity;
  message: string;
  traceId: string;
  data: Record<string, unknown>;
}

export interface RunnerHealthState {
  schemaVersion: 1;
  status: RunnerHealthStatus;
  lastTickAt: string | null;
  lastSuccessfulTickAt: string | null;
  lastAuthoredFeatureAt: string | null;
  consecutiveZeroAuthoredTicks: number;
  consecutiveFailedTicks: number;
  lastProviderTierUsed: string | null;
  providerOutputInvalidCount: number;
  providerOutputInvalidWindowStartedAt: string | null;
  degradedToDeterministicCount: number;
  deterministicWindowStartedAt: string | null;
  recentAlerts: RunnerAlertEvent[];
  updatedAt: string;
}

export interface RunnerHealthSnapshot extends RunnerHealthState {
  stale: boolean;
}

export interface RunnerHealthConfig {
  healthFile: string;
  alertFeedFile: string;
  zeroAuthoredAlertThreshold: number;
  providerInvalidAlertThreshold: number;
  failedTickAlertThreshold: number;
  livenessWindowMs: number;
  rollingWindowMs: number;
  maxAlerts: number;
}

export type RunnerTickHealthInput = {
  traceId?: string;
  results: unknown[];
  env?: NodeJS.ProcessEnv;
  now?: Date;
};

const DEFAULT_ZERO_AUTHORED_ALERT_THRESHOLD = 3;
const DEFAULT_PROVIDER_INVALID_ALERT_THRESHOLD = 3;
const DEFAULT_FAILED_TICK_ALERT_THRESHOLD = 3;
const DEFAULT_LIVENESS_WINDOW_MS = 180_000;
const DEFAULT_ROLLING_WINDOW_MS = 3_600_000;
const DEFAULT_MAX_ALERTS = 25;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveRunnerHealthConfig(env: NodeJS.ProcessEnv = process.env): RunnerHealthConfig {
  const healthFile = resolve(env.AUTO_DOC_HEALTH_FILE?.trim() || ".auto-doc/runner-health.json");
  return {
    healthFile,
    alertFeedFile: resolve(env.AUTO_DOC_ALERT_FEED_FILE?.trim() || `${dirname(healthFile)}/alerts.jsonl`),
    zeroAuthoredAlertThreshold: readPositiveInt(
      env.AUTO_DOC_ZERO_AUTHORED_ALERT_THRESHOLD,
      DEFAULT_ZERO_AUTHORED_ALERT_THRESHOLD,
    ),
    providerInvalidAlertThreshold: readPositiveInt(
      env.AUTO_DOC_PROVIDER_INVALID_ALERT_THRESHOLD,
      DEFAULT_PROVIDER_INVALID_ALERT_THRESHOLD,
    ),
    failedTickAlertThreshold: readPositiveInt(env.AUTO_DOC_FAILED_TICK_ALERT_THRESHOLD, DEFAULT_FAILED_TICK_ALERT_THRESHOLD),
    livenessWindowMs: readPositiveInt(env.AUTO_DOC_HEALTH_LIVENESS_WINDOW_MS, DEFAULT_LIVENESS_WINDOW_MS),
    rollingWindowMs: readPositiveInt(env.AUTO_DOC_HEALTH_ROLLING_WINDOW_MS, DEFAULT_ROLLING_WINDOW_MS),
    maxAlerts: readPositiveInt(env.AUTO_DOC_HEALTH_MAX_ALERTS, DEFAULT_MAX_ALERTS),
  };
}

function createInitialState(now: Date): RunnerHealthState {
  const isoNow = now.toISOString();
  return {
    schemaVersion: 1,
    status: "healthy",
    lastTickAt: null,
    lastSuccessfulTickAt: null,
    lastAuthoredFeatureAt: null,
    consecutiveZeroAuthoredTicks: 0,
    consecutiveFailedTicks: 0,
    lastProviderTierUsed: null,
    providerOutputInvalidCount: 0,
    providerOutputInvalidWindowStartedAt: null,
    degradedToDeterministicCount: 0,
    deterministicWindowStartedAt: null,
    recentAlerts: [],
    updatedAt: isoNow,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function hasAlert(state: RunnerHealthState, failureMode: RunnerFailureMode): boolean {
  return state.recentAlerts.some((alert) => alert.failureMode === failureMode);
}

function detectProviderUsed(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }

  const analysis = isRecord(result.analysis) ? result.analysis : null;
  if (!analysis) {
    return null;
  }

  const narratives = isRecord(analysis.generatedNarratives) ? analysis.generatedNarratives : null;
  const narrativeProvider = narratives ? readString(narratives.providerUsed) : null;
  if (narrativeProvider) {
    return narrativeProvider;
  }

  const directProvider = readString(analysis.providerUsed);
  if (directProvider) {
    return directProvider;
  }

  if (Array.isArray(analysis.confidenceReasons)) {
    for (const reason of analysis.confidenceReasons) {
      const text = readString(reason);
      const match = text?.match(/Provider used:\s*(.+)$/i);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
  }

  return null;
}

function unwrapRunnerResult(tickResult: unknown): { result: unknown | null; error: string | null } {
  if (!isRecord(tickResult)) {
    return { result: null, error: "Runner result was not an object." };
  }

  const error = readString(tickResult.error);
  return {
    result: tickResult.result ?? null,
    error,
  };
}

function readRunnerTarget(tickResult: unknown): { projectId: string | null; repoPath: string | null } {
  if (!isRecord(tickResult) || !isRecord(tickResult.target)) {
    return { projectId: null, repoPath: null };
  }

  return {
    projectId: readString(tickResult.target.projectId),
    repoPath: readString(tickResult.target.repoPath),
  };
}

function isProjectMissingFromStateError(error: string): boolean {
  return error.includes("Unknown projectId") || error.includes("PROJECT_STATE_MIGRATION_FAILED");
}

function resultHasDocumentableChange(result: unknown): boolean {
  if (!isRecord(result)) {
    return false;
  }

  const capture = isRecord(result.capture) ? result.capture : null;
  const analysis = isRecord(result.analysis) ? result.analysis : null;
  return capture?.initialClassification === "true" || analysis?.shouldDocument === true;
}

function resultDocumentedCount(result: unknown): number {
  if (!isRecord(result)) {
    return 0;
  }

  const explicitCount = readNumber(result.documentedFeatureCount);
  if (explicitCount > 0) {
    return explicitCount;
  }

  return result.disposition === "documented" ? 1 : 0;
}

function resultHasProviderOutputInvalid(result: unknown): boolean {
  if (!isRecord(result)) {
    return false;
  }

  const analysis = isRecord(result.analysis) ? result.analysis : null;
  return analysis?.fallbackReasonCode === "provider_output_invalid" || readNumber(result.analyzerFailureCount) > 0;
}

async function loadHealthState(config: RunnerHealthConfig, now: Date): Promise<RunnerHealthState> {
  try {
    const raw = await readFile(config.healthFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
      return createInitialState(now);
    }

    const fallback = createInitialState(now);
    return {
      schemaVersion: 1,
      status: parsed.status === "degraded" || parsed.status === "failing" ? parsed.status : "healthy",
      lastTickAt: readString(parsed.lastTickAt),
      lastSuccessfulTickAt: readString(parsed.lastSuccessfulTickAt),
      lastAuthoredFeatureAt: readString(parsed.lastAuthoredFeatureAt),
      consecutiveZeroAuthoredTicks: readNumber(parsed.consecutiveZeroAuthoredTicks),
      consecutiveFailedTicks: readNumber(parsed.consecutiveFailedTicks),
      lastProviderTierUsed: readString(parsed.lastProviderTierUsed),
      providerOutputInvalidCount: readNumber(parsed.providerOutputInvalidCount),
      providerOutputInvalidWindowStartedAt: readString(parsed.providerOutputInvalidWindowStartedAt),
      degradedToDeterministicCount: readNumber(parsed.degradedToDeterministicCount),
      deterministicWindowStartedAt: readString(parsed.deterministicWindowStartedAt),
      recentAlerts: Array.isArray(parsed.recentAlerts)
        ? parsed.recentAlerts.filter(isRunnerAlertEvent).slice(-config.maxAlerts)
        : fallback.recentAlerts,
      updatedAt: readString(parsed.updatedAt) ?? fallback.updatedAt,
    };
  } catch {
    return createInitialState(now);
  }
}

function isRunnerAlertEvent(value: unknown): value is RunnerAlertEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.emittedAt === "string" &&
    typeof value.failureMode === "string" &&
    typeof value.severity === "string" &&
    typeof value.message === "string" &&
    typeof value.traceId === "string" &&
    isRecord(value.data)
  );
}

async function saveHealthState(config: RunnerHealthConfig, state: RunnerHealthState): Promise<void> {
  await mkdir(dirname(config.healthFile), { recursive: true });
  await writeFile(config.healthFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function resetRollingCounterIfExpired(
  now: Date,
  windowStartedAt: string | null,
  rollingWindowMs: number,
): { countShouldReset: boolean; windowStartedAt: string | null } {
  if (!windowStartedAt) {
    return { countShouldReset: true, windowStartedAt: now.toISOString() };
  }

  const started = Date.parse(windowStartedAt);
  if (!Number.isFinite(started) || now.getTime() - started > rollingWindowMs) {
    return { countShouldReset: true, windowStartedAt: now.toISOString() };
  }

  return { countShouldReset: false, windowStartedAt };
}

async function appendAlertFeedLine(
  config: RunnerHealthConfig,
  state: RunnerHealthState,
  alert: RunnerAlertEvent,
): Promise<void> {
  await mkdir(dirname(config.alertFeedFile), { recursive: true });
  const feedLine = {
    schemaVersion: 1,
    timestamp: alert.emittedAt,
    emittedAt: alert.emittedAt,
    alertId: alert.id,
    failureMode: alert.failureMode,
    severity: alert.severity,
    status: state.status,
    traceId: alert.traceId,
    message: alert.message,
    consecutiveZeroAuthoredTicks: state.consecutiveZeroAuthoredTicks,
    consecutiveFailedTicks: state.consecutiveFailedTicks,
    providerOutputInvalidCount: state.providerOutputInvalidCount,
    degradedToDeterministicCount: state.degradedToDeterministicCount,
    lastProviderTierUsed: state.lastProviderTierUsed,
    healthFile: config.healthFile,
    alertFeedFile: config.alertFeedFile,
    data: redactJsonValue(alert.data),
  };
  const handle = await open(config.alertFeedFile, "a");
  try {
    await handle.writeFile(`${JSON.stringify(feedLine)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function statusForAlert(failureMode: RunnerFailureMode): RunnerHealthStatus {
  if (
    failureMode === "degraded_to_deterministic" ||
    failureMode === "project_missing_from_state" ||
    failureMode === "project_discovery_failed" ||
    failureMode === "runner_liveness_stale" ||
    failureMode === "runner_tick_failure_threshold"
  ) {
    return "failing";
  }

  return "degraded";
}

// The alert feed is the append-only integration point for future consumers
// such as webhooks, email, chat, dashboards, watchdogs, or observability sinks.
// The runner is the sole producer; consumers should tail JSONL by schemaVersion
// and timestamp without writing back to this file.
async function emitAlert(
  state: RunnerHealthState,
  config: RunnerHealthConfig,
  input: {
    failureMode: RunnerFailureMode;
    severity: RunnerAlertSeverity;
    message: string;
    traceId: string;
    now: Date;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const alert: RunnerAlertEvent = {
    id: randomUUID(),
    emittedAt: input.now.toISOString(),
    failureMode: input.failureMode,
    severity: input.severity,
    message: input.message,
    traceId: input.traceId,
    data: redactJsonValue(input.data) as Record<string, unknown>,
  };

  state.status = statusForAlert(input.failureMode);
  state.recentAlerts = [...state.recentAlerts, alert].slice(-config.maxAlerts);
  await appendAlertFeedLine(config, state, alert);
  logToolEvent({
    level: input.severity === "critical" ? "error" : "warn",
    tool: "monitoring_alert",
    stage: input.failureMode,
    traceId: input.traceId,
    message: input.message,
    data: { ...alert },
  });
}

export async function emitRunnerHealthAlert(input: {
  failureMode: RunnerFailureMode;
  severity: RunnerAlertSeverity;
  message: string;
  traceId?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  data: Record<string, unknown>;
}): Promise<RunnerHealthSnapshot> {
  const now = input.now ?? new Date();
  const traceId = resolveTraceId(input.traceId);
  const config = resolveRunnerHealthConfig(input.env);
  const state = await loadHealthState(config, now);
  state.updatedAt = now.toISOString();
  await emitAlert(state, config, {
    failureMode: input.failureMode,
    severity: input.severity,
    message: input.message,
    traceId,
    now,
    data: input.data,
  });
  const snapshot = await withStaleComputed(state, config, now, traceId, { suppressLivenessAlert: true });
  await saveHealthState(config, state);
  return snapshot;
}

async function withStaleComputed(
  state: RunnerHealthState,
  config: RunnerHealthConfig,
  now: Date,
  traceId: string,
  options: { suppressLivenessAlert?: boolean } = {},
): Promise<RunnerHealthSnapshot> {
  const successfulAt = state.lastSuccessfulTickAt ? Date.parse(state.lastSuccessfulTickAt) : NaN;
  const stale = !Number.isFinite(successfulAt) || now.getTime() - successfulAt > config.livenessWindowMs;

  if (stale) {
    state.status = "failing";
    if (!options.suppressLivenessAlert && !hasAlert(state, "runner_liveness_stale")) {
      await emitAlert(state, config, {
        failureMode: "runner_liveness_stale",
        severity: "critical",
        traceId,
        now,
        message: "No successful continuous documentation runner tick was observed within the liveness window.",
        data: {
          lastSuccessfulTickAt: state.lastSuccessfulTickAt,
          livenessWindowMs: config.livenessWindowMs,
        },
      });
    }
  }

  return { ...state, stale };
}

function recomputeStatus(state: RunnerHealthState, config: RunnerHealthConfig): RunnerHealthStatus {
  if (state.lastProviderTierUsed === "deterministic" || state.consecutiveFailedTicks >= config.failedTickAlertThreshold) {
    return "failing";
  }

  if (
    state.consecutiveZeroAuthoredTicks >= config.zeroAuthoredAlertThreshold ||
    state.providerOutputInvalidCount >= config.providerInvalidAlertThreshold
  ) {
    return "degraded";
  }

  return "healthy";
}

export async function recordRunnerTickHealth(input: RunnerTickHealthInput): Promise<RunnerHealthSnapshot> {
  const now = input.now ?? new Date();
  const traceId = resolveTraceId(input.traceId);
  const config = resolveRunnerHealthConfig(input.env);
  const state = await loadHealthState(config, now);
  const isoNow = now.toISOString();

  let failedTargets = 0;
  let documentableTargets = 0;
  let authoredFeatures = 0;
  let providerOutputInvalid = 0;
  let latestProvider: string | null = null;
  let projectMissingFromState: { projectId: string | null; repoPath: string | null; error: string } | null = null;

  for (const tickResult of input.results) {
    const unwrapped = unwrapRunnerResult(tickResult);
    if (unwrapped.error) {
      failedTargets += 1;
      if (!projectMissingFromState && isProjectMissingFromStateError(unwrapped.error)) {
        projectMissingFromState = {
          ...readRunnerTarget(tickResult),
          error: unwrapped.error,
        };
      }
      continue;
    }

    const result = unwrapped.result;
    const provider = detectProviderUsed(result);
    if (provider) {
      latestProvider = provider;
    }

    if (resultHasDocumentableChange(result)) {
      documentableTargets += 1;
    }

    authoredFeatures += resultDocumentedCount(result);
    if (resultHasProviderOutputInvalid(result)) {
      providerOutputInvalid += 1;
    }
  }

  state.lastTickAt = isoNow;
  state.updatedAt = isoNow;
  if (latestProvider) {
    state.lastProviderTierUsed = latestProvider;
  }

  if (failedTargets > 0) {
    state.consecutiveFailedTicks += 1;
  } else {
    state.consecutiveFailedTicks = 0;
    state.lastSuccessfulTickAt = isoNow;
  }

  if (projectMissingFromState) {
    await emitAlert(state, config, {
      failureMode: "project_missing_from_state",
      severity: "critical",
      traceId,
      now,
      message: "Continuous documentation runner could not find the configured project in the resolved state file.",
      data: {
        projectId: projectMissingFromState.projectId,
        repoPath: projectMissingFromState.repoPath,
        resolvedStateFile: resolveStateStorePath(input.env).filePath,
        error: projectMissingFromState.error,
      },
    });
  }

  if (authoredFeatures > 0) {
    state.lastAuthoredFeatureAt = isoNow;
    state.consecutiveZeroAuthoredTicks = 0;
  } else if (documentableTargets > 0) {
    state.consecutiveZeroAuthoredTicks += 1;
  }

  if (providerOutputInvalid > 0) {
    const reset = resetRollingCounterIfExpired(
      now,
      state.providerOutputInvalidWindowStartedAt,
      config.rollingWindowMs,
    );
    state.providerOutputInvalidWindowStartedAt = reset.windowStartedAt;
    state.providerOutputInvalidCount = reset.countShouldReset
      ? providerOutputInvalid
      : state.providerOutputInvalidCount + providerOutputInvalid;
  }

  if (latestProvider === "deterministic") {
    const reset = resetRollingCounterIfExpired(now, state.deterministicWindowStartedAt, config.rollingWindowMs);
    state.deterministicWindowStartedAt = reset.windowStartedAt;
    state.degradedToDeterministicCount = reset.countShouldReset ? 1 : state.degradedToDeterministicCount + 1;
    await emitAlert(state, config, {
      failureMode: "degraded_to_deterministic",
      severity: "critical",
      traceId,
      now,
      message: "Continuous documentation runner degraded to deterministic output on the latest tick.",
      data: {
        providerUsed: latestProvider,
        degradedToDeterministicCount: state.degradedToDeterministicCount,
      },
    });
  }

  if (
    documentableTargets > 0 &&
    authoredFeatures === 0 &&
    state.consecutiveZeroAuthoredTicks === config.zeroAuthoredAlertThreshold
  ) {
    await emitAlert(state, config, {
      failureMode: "zero_authored_threshold",
      severity: "warning",
      traceId,
      now,
      message: "Documentable runner ticks produced zero authored features for the configured threshold.",
      data: {
        consecutiveZeroAuthoredTicks: state.consecutiveZeroAuthoredTicks,
        threshold: config.zeroAuthoredAlertThreshold,
      },
    });
  }

  if (providerOutputInvalid > 0 && state.providerOutputInvalidCount === config.providerInvalidAlertThreshold) {
    await emitAlert(state, config, {
      failureMode: "provider_output_invalid_threshold",
      severity: "warning",
      traceId,
      now,
      message: "Provider output was invalid repeatedly within the rolling monitoring window.",
      data: {
        providerOutputInvalidCount: state.providerOutputInvalidCount,
        threshold: config.providerInvalidAlertThreshold,
        windowStartedAt: state.providerOutputInvalidWindowStartedAt,
      },
    });
  }

  if (!projectMissingFromState && state.consecutiveFailedTicks === config.failedTickAlertThreshold) {
    await emitAlert(state, config, {
      failureMode: "runner_tick_failure_threshold",
      severity: "critical",
      traceId,
      now,
      message: "Continuous documentation runner target failures reached the configured threshold.",
      data: {
        consecutiveFailedTicks: state.consecutiveFailedTicks,
        threshold: config.failedTickAlertThreshold,
      },
    });
  }

  state.status = recomputeStatus(state, config);
  const snapshot = await withStaleComputed(state, config, now, traceId, {
    suppressLivenessAlert: Boolean(projectMissingFromState),
  });
  await saveHealthState(config, state);
  return snapshot;
}

export async function getRunnerHealth(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  traceId: string = resolveTraceId(),
): Promise<RunnerHealthSnapshot> {
  const config = resolveRunnerHealthConfig(env);
  const state = await loadHealthState(config, now);
  state.updatedAt = now.toISOString();
  const snapshot = await withStaleComputed(state, config, now, traceId);
  await saveHealthState(config, state);
  return snapshot;
}
