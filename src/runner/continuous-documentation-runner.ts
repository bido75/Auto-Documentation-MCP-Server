import EventEmitter from "node:events";
import { simpleGit } from "simple-git";
import { executeAutonomousDocumentationTrigger } from "../orchestrator/auto-doc-orchestrator.js";
import { getStateStore } from "../lib/state-store.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { registerRunReleaseDocumentationPipelineTool } from "../tools/run-release-documentation-pipeline.js";

const DEFAULT_MAX_CONCURRENT_TARGETS = 4;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_CIRCUIT_RESET_AFTER_MS = 300_000;
const DEFAULT_PER_TARGET_TIMEOUT_MS = 60_000;

export interface ContinuousRunnerTarget {
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
}

export interface ContinuousRunnerConfig {
  pollIntervalMs: number;
  targets: ContinuousRunnerTarget[];
  maxConcurrentTargets?: number;
  maxConsecutiveFailures?: number;
  circuitResetAfterMs?: number;
  perTargetTimeoutMs?: number;
  traceId?: string;
}

type RunnerTickResult = {
  target: ContinuousRunnerTarget;
  result: unknown | null;
  error?: string;
  releaseTag?: string | null;
  releasePipeline?: unknown | null;
};

type TargetState = {
  consecutiveFailures: number;
  circuitOpen: boolean;
  lastAttemptAt: number | null;
};

type TriggerExecutor = typeof executeAutonomousDocumentationTrigger;

type ReleasePipelineInput = {
  projectId: string;
  releaseVersion: string;
  repoPath: string;
  mode: "staged" | "last_commit" | "working_tree";
  prUrl?: string;
  audience?: "user" | "admin" | "both";
  packageFormat?: "notion_page" | "markdown";
  pdfOutputPath?: string;
  localDocsOutputPath?: string;
  helpCenterOutputPath?: string;
  traceId?: string;
};

type ReleasePipelineRunner = (input: ReleasePipelineInput) => Promise<unknown>;

type LatestTagResolver = (repoPath: string) => Promise<string | null>;

class InMemoryToolHost {
  public readonly handlers = new Map<
    string,
    (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>
  >();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) {
    this.handlers.set(name, handler);
  }
}

function parseToolText(result: { content: Array<{ type: string; text: string }> }): unknown {
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("Tool did not return a text payload.");
  }

  return JSON.parse(first.text);
}

function normalizeReleaseVersionFromTag(tag: string): string {
  return tag.replace(/^v/i, "");
}

function releaseTagKey(projectId: string, repoPath: string): string {
  return `${projectId}::${repoPath}`;
}

async function recordReleaseAutomationRun(input: {
  stateStore: ReturnType<typeof getStateStore>;
  projectId: string;
  repoPath: string;
  releaseTag: string;
  releaseVersion: string;
  status: "success" | "failure";
  errorMessage?: string;
}): Promise<void> {
  await input.stateStore.setReleaseAutomationRun({
    projectId: input.projectId,
    repoPath: input.repoPath,
    releaseTag: input.releaseTag,
    releaseVersion: input.releaseVersion,
    status: input.status,
    attemptedAt: new Date().toISOString(),
    errorMessage: input.errorMessage,
  });
}

async function resolveLatestReleaseTag(repoPath: string): Promise<string | null> {
  const git = simpleGit(repoPath);
  try {
    const value = await git.raw(["describe", "--tags", "--abbrev=0"]);
    const tag = value.trim();
    return tag.length > 0 ? tag : null;
  } catch {
    return null;
  }
}

async function runReleasePipeline(input: ReleasePipelineInput): Promise<unknown> {
  const host = new InMemoryToolHost();
  registerRunReleaseDocumentationPipelineTool(host as never);
  const handler = host.handlers.get("run_release_documentation_pipeline");
  if (!handler) {
    throw new Error("Release pipeline handler unavailable.");
  }

  return parseToolText(
    await handler({
      projectId: input.projectId,
      releaseVersion: input.releaseVersion,
      repoPath: input.repoPath,
      mode: input.mode,
      prUrl: input.prUrl,
      audience: input.audience,
      packageFormat: input.packageFormat,
      pdfOutputPath: input.pdfOutputPath,
      localDocsOutputPath: input.localDocsOutputPath,
      helpCenterOutputPath: input.helpCenterOutputPath,
      traceId: input.traceId,
    }),
  );
}

export class ContinuousDocumentationRunner extends EventEmitter {
  private readonly config: ContinuousRunnerConfig;
  private readonly executor: TriggerExecutor;
  private readonly resolveLatestTag: LatestTagResolver;
  private readonly releasePipelineRunner: ReleasePipelineRunner;
  private readonly stateStore: ReturnType<typeof getStateStore>;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private lastTickAt: string | null = null;
  private completedTicks = 0;
  private lastResults: RunnerTickResult[] = [];
  private lastSeenReleaseTags = new Map<string, string>();
  private targetState = new Map<string, TargetState>();

  constructor(
    config: ContinuousRunnerConfig,
    executor: TriggerExecutor = executeAutonomousDocumentationTrigger,
    resolveLatestTag: LatestTagResolver = resolveLatestReleaseTag,
    releasePipelineRunner: ReleasePipelineRunner = runReleasePipeline,
    stateStore = getStateStore(),
  ) {
    super();
    this.config = config;
    this.executor = executor;
    this.resolveLatestTag = resolveLatestTag;
    this.releasePipelineRunner = releasePipelineRunner;
    this.stateStore = stateStore;
  }

  getSnapshot() {
    return {
      running: this.running,
      stopped: this.stopped,
      lastTickAt: this.lastTickAt,
      completedTicks: this.completedTicks,
      lastResults: [...this.lastResults],
    };
  }

  async start() {
    if (this.running) {
      return this.getSnapshot();
    }

    this.stopped = false;
    this.running = true;
    this.emit("started");
    await this.tick();
    this.scheduleNext();
    return this.getSnapshot();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.running = false;
    this.emit("stopped");
    return this.getSnapshot();
  }

  private scheduleNext() {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.tick()
        .catch((error) => {
          const traceId = resolveTraceId(this.config.traceId);
          const message = error instanceof Error ? error.message : String(error);
          logToolEvent({
            level: "error",
            tool: "continuous_documentation_runner",
            stage: "tick_failure",
            traceId,
            message: "Continuous documentation runner tick failed",
            data: { error: message },
          });
        })
        .finally(() => {
          this.scheduleNext();
        });
    }, this.config.pollIntervalMs);
  }

  private get maxConcurrentTargets(): number {
    return this.config.maxConcurrentTargets ?? DEFAULT_MAX_CONCURRENT_TARGETS;
  }

  private get maxConsecutiveFailures(): number {
    return this.config.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  }

  private get circuitResetAfterMs(): number {
    return this.config.circuitResetAfterMs ?? DEFAULT_CIRCUIT_RESET_AFTER_MS;
  }

  private get perTargetTimeoutMs(): number {
    return this.config.perTargetTimeoutMs ?? DEFAULT_PER_TARGET_TIMEOUT_MS;
  }

  private getTargetKey(target: ContinuousRunnerTarget): string {
    return `${target.projectId}::${target.repoPath}`;
  }

  private getTargetState(target: ContinuousRunnerTarget): TargetState {
    const key = this.getTargetKey(target);
    const existing = this.targetState.get(key);
    if (existing) {
      return existing;
    }

    const created: TargetState = {
      consecutiveFailures: 0,
      circuitOpen: false,
      lastAttemptAt: null,
    };
    this.targetState.set(key, created);
    return created;
  }

  private isCircuitOpen(target: ContinuousRunnerTarget, traceId: string): boolean {
    const state = this.getTargetState(target);
    if (!state.circuitOpen) {
      return false;
    }

    const elapsed = Date.now() - (state.lastAttemptAt ?? 0);
    if (elapsed > this.circuitResetAfterMs) {
      state.circuitOpen = false;
      state.consecutiveFailures = 0;
      this.emit("circuit:reset", { projectId: target.projectId, repoPath: target.repoPath });
      logToolEvent({
        level: "info",
        tool: "continuous_documentation_runner",
        stage: "circuit_reset",
        traceId,
        message: "Runner target circuit reset",
        data: { projectId: target.projectId, repoPath: target.repoPath },
      });
      return false;
    }

    return true;
  }

  private async processTargetWithTimeout(target: ContinuousRunnerTarget, traceId: string): Promise<RunnerTickResult> {
    const targetState = this.getTargetState(target);
    const mode = target.mode ?? "working_tree";
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), this.perTargetTimeoutMs);
    targetState.lastAttemptAt = Date.now();

    try {
      const processed = await Promise.race([
        this.processTarget(target, mode, traceId, abortController.signal),
        new Promise<never>((_, reject) => {
          abortController.signal.addEventListener(
            "abort",
            () => {
              reject(new Error(`Timed out after ${this.perTargetTimeoutMs}ms`));
            },
            { once: true },
          );
        }),
      ]);

      targetState.consecutiveFailures = 0;
      this.emit("tick:success", { projectId: target.projectId, repoPath: target.repoPath });
      return processed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      targetState.consecutiveFailures += 1;
      this.emit("tick:failure", {
        projectId: target.projectId,
        repoPath: target.repoPath,
        error: message,
        count: targetState.consecutiveFailures,
      });

      if (targetState.consecutiveFailures >= this.maxConsecutiveFailures) {
        targetState.circuitOpen = true;
        this.emit("circuit:opened", { projectId: target.projectId, repoPath: target.repoPath });
      }

      logToolEvent({
        level: "error",
        tool: "continuous_documentation_runner",
        stage: targetState.circuitOpen ? "circuit_opened" : "failure",
        traceId,
        message: targetState.circuitOpen
          ? "Continuous documentation runner target opened its circuit breaker"
          : "Continuous documentation runner target failed",
        data: {
          projectId: target.projectId,
          repoPath: target.repoPath,
          mode,
          error: message,
          consecutiveFailures: targetState.consecutiveFailures,
        },
      });

      return { target, result: null, error: message };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async processTarget(
    target: ContinuousRunnerTarget,
    mode: "staged" | "last_commit" | "working_tree",
    traceId: string,
    signal: AbortSignal,
  ): Promise<RunnerTickResult> {
    const result = await this.executor({
      projectId: target.projectId,
      repoPath: target.repoPath,
      mode,
      traceId,
      signal,
    });

    let releaseTag: string | null = null;
    let releasePipeline: unknown | null = null;

    if (target.releaseAutomation) {
      const targetKey = releaseTagKey(target.projectId, target.repoPath);
      let previousTag = this.lastSeenReleaseTags.get(targetKey);
      if (previousTag === undefined) {
        previousTag = (await this.stateStore.getLastSeenReleaseTag(target.projectId, target.repoPath)) ?? undefined;
        if (previousTag) {
          this.lastSeenReleaseTags.set(targetKey, previousTag);
        }
      }

      releaseTag = await this.resolveLatestTag(target.repoPath);
      if (releaseTag) {
        if (previousTag !== releaseTag) {
          const releaseVersion = normalizeReleaseVersionFromTag(releaseTag);
          try {
            releasePipeline = await this.releasePipelineRunner({
              projectId: target.projectId,
              releaseVersion,
              repoPath: target.repoPath,
              mode,
              prUrl: target.releasePrUrl,
              audience: target.releaseAudience,
              packageFormat: target.releasePackageFormat,
              pdfOutputPath: target.releasePdfOutputPath,
              localDocsOutputPath: target.releaseLocalDocsOutputPath,
              helpCenterOutputPath: target.releaseHelpCenterOutputPath,
              traceId,
            });

            logToolEvent({
              level: "info",
              tool: "continuous_documentation_runner",
              stage: "release_automation_success",
              traceId,
              message: "Triggered release automation pipeline from detected tag",
              data: { projectId: target.projectId, repoPath: target.repoPath, releaseTag, releaseVersion },
            });

            await this.stateStore.setLastSeenReleaseTag(target.projectId, target.repoPath, releaseTag);
            await recordReleaseAutomationRun({
              stateStore: this.stateStore,
              projectId: target.projectId,
              repoPath: target.repoPath,
              releaseTag,
              releaseVersion,
              status: "success",
            });
          } catch (releaseError) {
            const releaseErrorMessage = releaseError instanceof Error ? releaseError.message : String(releaseError);
            await recordReleaseAutomationRun({
              stateStore: this.stateStore,
              projectId: target.projectId,
              repoPath: target.repoPath,
              releaseTag,
              releaseVersion,
              status: "failure",
              errorMessage: releaseErrorMessage,
            });
            throw releaseError;
          }
        }

        this.lastSeenReleaseTags.set(targetKey, releaseTag);
      }
    }

    return { target, result, releaseTag, releasePipeline };
  }

  async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }

    const traceId = resolveTraceId(this.config.traceId);
    this.lastTickAt = new Date().toISOString();
    this.completedTicks += 1;

    const runnableTargets = this.config.targets.filter((target) => !this.isCircuitOpen(target, traceId));
    const skippedTargets: RunnerTickResult[] = this.config.targets
      .filter((target) => !runnableTargets.includes(target))
      .map((target) => ({
        target,
        result: null,
        error: "Skipped because the circuit breaker is open for this target.",
      }));

    const results: RunnerTickResult[] = [];
    for (let index = 0; index < runnableTargets.length; index += this.maxConcurrentTargets) {
      const chunk = runnableTargets.slice(index, index + this.maxConcurrentTargets);
      const chunkResults = await Promise.all(chunk.map((target) => this.processTargetWithTimeout(target, traceId)));
      results.push(...chunkResults);
    }

    if (skippedTargets.length > 0) {
      results.push(...skippedTargets);
      for (const skipped of skippedTargets) {
        logToolEvent({
          level: "warn",
          tool: "continuous_documentation_runner",
          stage: "circuit_skip",
          traceId,
          message: "Skipped runner target because its circuit breaker is open",
          data: { projectId: skipped.target.projectId, repoPath: skipped.target.repoPath },
        });
      }
    }

    this.lastResults = results;
    logToolEvent({
      level: "info",
      tool: "continuous_documentation_runner",
      stage: "success",
      traceId,
      message: "Completed continuous documentation runner tick",
      data: {
        targetCount: this.config.targets.length,
        completedTicks: this.completedTicks,
      },
    });
  }
}
