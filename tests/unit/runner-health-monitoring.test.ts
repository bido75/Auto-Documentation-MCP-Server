import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitRunnerHealthAlert,
  getRunnerHealth,
  recordRunnerTickHealth,
  type RunnerHealthSnapshot,
} from "../../src/lib/runner-health.js";

type ToolPayload = { content: Array<{ type: string; text: string }> };

const baseTarget = { projectId: "project_1", repoPath: "C:/repo", mode: "last_commit" };

function envFor(healthFile: string): NodeJS.ProcessEnv {
  return {
    AUTO_DOC_HEALTH_FILE: healthFile,
    AUTO_DOC_ALERT_FEED_FILE: join(healthFile, "..", "alerts.jsonl"),
    AUTO_DOC_ZERO_AUTHORED_ALERT_THRESHOLD: "2",
    AUTO_DOC_PROVIDER_INVALID_ALERT_THRESHOLD: "2",
    AUTO_DOC_FAILED_TICK_ALERT_THRESHOLD: "2",
    AUTO_DOC_HEALTH_LIVENESS_WINDOW_MS: "1000",
    AUTO_DOC_HEALTH_ROLLING_WINDOW_MS: "60000",
    AUTO_DOC_HEALTH_MAX_ALERTS: "10",
    AUTO_DOC_LOG_LEVEL: "info",
  } as NodeJS.ProcessEnv;
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, "utf8");
  return raw
    .trimEnd()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function documentedResult(providerUsed: string) {
  return {
    target: baseTarget,
    result: {
      ok: true,
      disposition: "documented",
      documentedFeatureCount: 1,
      capture: { initialClassification: "true" },
      analysis: {
        shouldDocument: true,
        fallbackReasonCode: "none",
        confidenceReasons: [`Provider used: ${providerUsed}`],
        generatedNarratives: { providerUsed },
      },
    },
  };
}

function documentableButZeroAuthoredResult() {
  return {
    target: baseTarget,
    result: {
      ok: true,
      disposition: "skipped",
      documentedFeatureCount: 0,
      skippedCount: 1,
      capture: { initialClassification: "true" },
      analysis: {
        shouldDocument: true,
        fallbackReasonCode: "none",
        confidenceReasons: ["Provider used: openrouter:qwen/qwen3-next-80b-a3b-instruct"],
        generatedNarratives: { providerUsed: "openrouter:qwen/qwen3-next-80b-a3b-instruct" },
      },
    },
  };
}

function providerInvalidResult() {
  return {
    target: baseTarget,
    result: {
      ok: true,
      disposition: "skipped",
      documentedFeatureCount: 0,
      analyzerFailureCount: 1,
      capture: { initialClassification: "true" },
      analysis: {
        shouldDocument: true,
        fallbackReasonCode: "provider_output_invalid",
        confidenceReasons: ["Provider output invalid"],
      },
    },
  };
}

function missingProjectResult() {
  return {
    target: { projectId: "missing_project", repoPath: "C:/repo", mode: "last_commit" },
    result: null,
    error: "Unknown projectId 'missing_project'. Run initialize_project_manual first.",
  };
}

function alertModes(health: RunnerHealthSnapshot): string[] {
  return health.recentAlerts.map((alert) => alert.failureMode);
}

describe("runner silent-failure monitoring", () => {
  const logs: string[] = [];
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs.length = 0;
    warnSpy = vi.spyOn(console, "warn").mockImplementation((line: string) => {
      logs.push(line);
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => {
      logs.push(line);
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("persists failing health and emits a structured alert when the latest tick degrades to deterministic output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const env = envFor(join(dir, "health.json"));

    const health = await recordRunnerTickHealth({
      traceId: "trace-deterministic",
      env,
      results: [documentedResult("deterministic")],
    });

    expect(health.status).toBe("failing");
    expect(health.lastProviderTierUsed).toBe("deterministic");
    expect(health.degradedToDeterministicCount).toBe(1);
    expect(alertModes(health)).toContain("degraded_to_deterministic");
    expect(logs.some((line) => line.includes('"tool":"monitoring_alert"') && line.includes("degraded_to_deterministic"))).toBe(true);

    const persisted = JSON.parse(await readFile(env.AUTO_DOC_HEALTH_FILE!, "utf8")) as RunnerHealthSnapshot;
    expect(persisted.status).toBe("failing");
    expect(alertModes(persisted)).toContain("degraded_to_deterministic");
  });

  it("appends each emitted alert to a separate parseable JSONL feed line with required fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const env = envFor(join(dir, "health.json"));

    await recordRunnerTickHealth({
      traceId: "trace-feed-deterministic",
      env,
      results: [documentedResult("deterministic")],
    });

    const lines = await readJsonl(env.AUTO_DOC_ALERT_FEED_FILE!);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      schemaVersion: 1,
      failureMode: "degraded_to_deterministic",
      status: "failing",
      traceId: "trace-feed-deterministic",
      degradedToDeterministicCount: 1,
      consecutiveZeroAuthoredTicks: 0,
      consecutiveFailedTicks: 0,
    });
    expect(typeof lines[0]?.timestamp).toBe("string");
    expect(lines[0]?.timestamp).toBe(lines[0]?.emittedAt);
    expect(lines[0]?.healthFile).toBe(env.AUTO_DOC_HEALTH_FILE);
    expect(lines[0]?.alertFeedFile).toBe(env.AUTO_DOC_ALERT_FEED_FILE);
    expect(lines[0]?.healthFile).not.toBe(lines[0]?.alertFeedFile);
  });

  it("alerts only after documentable ticks produce zero authored features for the configured threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const env = envFor(join(dir, "health.json"));

    const first = await recordRunnerTickHealth({
      traceId: "trace-zero-1",
      env,
      results: [documentableButZeroAuthoredResult()],
    });
    expect(first.consecutiveZeroAuthoredTicks).toBe(1);
    expect(alertModes(first)).not.toContain("zero_authored_threshold");

    const second = await recordRunnerTickHealth({
      traceId: "trace-zero-2",
      env,
      results: [documentableButZeroAuthoredResult()],
    });
    expect(second.status).toBe("degraded");
    expect(second.consecutiveZeroAuthoredTicks).toBe(2);
    expect(alertModes(second)).toContain("zero_authored_threshold");
    expect(logs.some((line) => line.includes('"tool":"monitoring_alert"') && line.includes("zero_authored_threshold"))).toBe(true);
  });

  it("alerts after repeated provider_output_invalid analyzer failures within the rolling window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const env = envFor(join(dir, "health.json"));

    await recordRunnerTickHealth({ traceId: "trace-invalid-1", env, results: [providerInvalidResult()] });
    const health = await recordRunnerTickHealth({ traceId: "trace-invalid-2", env, results: [providerInvalidResult()] });

    expect(health.status).toBe("degraded");
    expect(health.providerOutputInvalidCount).toBe(2);
    expect(alertModes(health)).toContain("provider_output_invalid_threshold");
    expect(logs.some((line) => line.includes('"tool":"monitoring_alert"') && line.includes("provider_output_invalid_threshold"))).toBe(true);
  });

  it("appends multiple alert feed events in order without rewriting earlier JSONL lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const env = envFor(join(dir, "health.json"));

    await recordRunnerTickHealth({ traceId: "trace-feed-invalid-1", env, results: [providerInvalidResult()] });
    await recordRunnerTickHealth({ traceId: "trace-feed-invalid-2", env, results: [providerInvalidResult()] });
    const afterProviderInvalidRaw = await readFile(env.AUTO_DOC_ALERT_FEED_FILE!, "utf8");
    const afterProviderInvalid = await readJsonl(env.AUTO_DOC_ALERT_FEED_FILE!);

    await recordRunnerTickHealth({ traceId: "trace-feed-deterministic", env, results: [documentedResult("deterministic")] });
    const afterDeterministicRaw = await readFile(env.AUTO_DOC_ALERT_FEED_FILE!, "utf8");
    const afterDeterministic = await readJsonl(env.AUTO_DOC_ALERT_FEED_FILE!);

    expect(afterProviderInvalid.map((line) => line.failureMode)).toEqual([
      "zero_authored_threshold",
      "provider_output_invalid_threshold",
    ]);
    expect(afterDeterministic.map((line) => line.failureMode)).toEqual([
      "zero_authored_threshold",
      "provider_output_invalid_threshold",
      "degraded_to_deterministic",
    ]);
    expect(afterDeterministicRaw.startsWith(afterProviderInvalidRaw)).toBe(true);
  });

  it("emits a specific project_missing_from_state alert with project and state-path evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const stateFile = join(dir, "isolated", "state.json");
    const env = {
      ...envFor(join(dir, "health.json")),
      AUTO_DOC_STATE_FILE: stateFile,
    };

    const health = await recordRunnerTickHealth({
      traceId: "trace-missing-project",
      env,
      results: [missingProjectResult()],
    });

    expect(health.status).toBe("failing");
    expect(alertModes(health)).toContain("project_missing_from_state");
    expect(alertModes(health)).not.toContain("runner_liveness_stale");
    expect(alertModes(health)).not.toContain("runner_tick_failure_threshold");

    const lines = await readJsonl(env.AUTO_DOC_ALERT_FEED_FILE!);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      failureMode: "project_missing_from_state",
      severity: "critical",
      traceId: "trace-missing-project",
      data: {
        projectId: "missing_project",
        repoPath: "C:/repo",
        resolvedStateFile: stateFile,
      },
    });
    expect(logs.some((line) => line.includes('"tool":"monitoring_alert"') && line.includes("project_missing_from_state"))).toBe(true);
  });

  it("computes stale liveness on health_check queries and emits the liveness alert once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const env = envFor(join(dir, "health.json"));

    await recordRunnerTickHealth({
      traceId: "trace-old",
      env,
      now: new Date("2026-06-17T12:00:00.000Z"),
      results: [documentedResult("openrouter:qwen/qwen3-next-80b-a3b-instruct")],
    });

    const health = await getRunnerHealth(env, new Date("2026-06-17T12:00:05.000Z"), "trace-query");
    expect(health.stale).toBe(true);
    expect(health.status).toBe("failing");
    expect(alertModes(health)).toContain("runner_liveness_stale");
    expect(logs.some((line) => line.includes('"tool":"monitoring_alert"') && line.includes("runner_liveness_stale"))).toBe(true);
  });

  it("keeps recovered provider fallbacks healthy when the tick authors with a non-deterministic provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const env = envFor(join(dir, "health.json"));

    const health = await recordRunnerTickHealth({
      traceId: "trace-recovered",
      env,
      results: [documentedResult("openrouter:qwen/qwen3-next-80b-a3b-instruct")],
    });

    expect(health.status).toBe("healthy");
    expect(health.stale).toBe(false);
    expect(health.consecutiveZeroAuthoredTicks).toBe(0);
    expect(health.recentAlerts).toEqual([]);
    expect(logs.some((line) => line.includes('"tool":"monitoring_alert"'))).toBe(false);
    await expect(readFile(env.AUTO_DOC_ALERT_FEED_FILE!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("appends to an existing feed across separate health recorder runs instead of overwriting it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const env = envFor(join(dir, "health.json"));

    await recordRunnerTickHealth({
      traceId: "trace-restart-1",
      env,
      results: [documentedResult("deterministic")],
    });
    const firstRaw = await readFile(env.AUTO_DOC_ALERT_FEED_FILE!, "utf8");
    const firstLines = await readJsonl(env.AUTO_DOC_ALERT_FEED_FILE!);

    const secondEnv = { ...env };
    await recordRunnerTickHealth({
      traceId: "trace-restart-2",
      env: secondEnv,
      results: [documentedResult("deterministic")],
    });

    const secondRaw = await readFile(env.AUTO_DOC_ALERT_FEED_FILE!, "utf8");
    const secondLines = await readJsonl(env.AUTO_DOC_ALERT_FEED_FILE!);
    expect(secondRaw.startsWith(firstRaw)).toBe(true);
    expect(firstLines).toHaveLength(1);
    expect(secondLines).toHaveLength(2);
    expect(secondLines.map((line) => line.traceId)).toEqual(["trace-restart-1", "trace-restart-2"]);
  });

  it("redacts secret-shaped values before persisting alert data to health and JSONL files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const env = envFor(join(dir, "health.json"));
    const tokenValue = "fixtureSecretValueForRedaction1234567890";

    await emitRunnerHealthAlert({
      traceId: "trace-redacted-feed",
      env,
      failureMode: "runner_tick_failure_threshold",
      severity: "critical",
      message: "Synthetic alert for redaction test",
      data: {
        nested: {
          error: `Notion call failed with NOTION_TOKEN=${tokenValue}`,
          authorization: `Bearer ${tokenValue}`,
        },
      },
    });

    const healthRaw = await readFile(env.AUTO_DOC_HEALTH_FILE!, "utf8");
    const feedRaw = await readFile(env.AUTO_DOC_ALERT_FEED_FILE!, "utf8");
    expect(healthRaw).not.toContain(tokenValue);
    expect(feedRaw).not.toContain(tokenValue);
    expect(feedRaw).toContain("[REDACTED]");
  });

  it("registers health_check and returns the persisted health object with stale status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-health-"));
    const env = envFor(join(dir, "health.json"));
    const previousEnv = process.env.AUTO_DOC_HEALTH_FILE;
    process.env.AUTO_DOC_HEALTH_FILE = env.AUTO_DOC_HEALTH_FILE;

    try {
      await recordRunnerTickHealth({ traceId: "trace-tool", env, results: [documentedResult("deterministic")] });
      const handlers = new Map<string, (input: { traceId?: string }) => Promise<ToolPayload>>();
      const server = {
        tool(
          name: string,
          _description: string,
          _schema: unknown,
          handler: (input: { traceId?: string }) => Promise<ToolPayload>,
        ) {
          handlers.set(name, handler);
        },
      };
      const { registerHealthCheckTool } = await import("../../src/tools/health-check.js");
      registerHealthCheckTool(server as never);

      const handler = handlers.get("health_check");
      expect(handler).toBeDefined();
      const payload = JSON.parse((await handler!({ traceId: "trace-health-tool" })).content[0]!.text) as RunnerHealthSnapshot;
      expect(payload.status).toBe("failing");
      expect(payload.lastProviderTierUsed).toBe("deterministic");
      expect(alertModes(payload)).toContain("degraded_to_deterministic");
    } finally {
      if (previousEnv === undefined) {
        delete process.env.AUTO_DOC_HEALTH_FILE;
      } else {
        process.env.AUTO_DOC_HEALTH_FILE = previousEnv;
      }
    }
  });
});
