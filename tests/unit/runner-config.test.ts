import { afterEach, describe, expect, it } from "vitest";
import { getOptionalRuntimeConfig } from "../../src/config.js";
import { parseContinuousRunnerConfig, parseContinuousRunnerTargets } from "../../src/runner/index.js";

const envKeys = [
  "AUTO_DOC_RUNNER_TARGETS",
  "AUTO_DOC_RUNNER_PROJECT_ID",
  "AUTO_DOC_RUNNER_REPO_PATH",
  "AUTO_DOC_RUNNER_MODE",
  "AUTO_DOC_RUNNER_RELEASE_AUTOMATION",
  "AUTO_DOC_RUNNER_RELEASE_AUDIENCE",
  "AUTO_DOC_RUNNER_RELEASE_PACKAGE_FORMAT",
  "AUTO_DOC_RUNTIME_MODE",
  "NOTION_TOKEN",
  "STATE_ENCRYPTION_KEY",
  "AI_TIMEOUT_MS",
  "AI_CLOUD_FALLBACK_MODEL",
  "AI_CLOUD_FALLBACK_MODELS",
  "RUNNER_TARGET_TIMEOUT_MS",
] as const;

const previousValues = new Map<(typeof envKeys)[number], string | undefined>();

function setRunnerEnv(values: Partial<Record<(typeof envKeys)[number], string | undefined>>): void {
  for (const key of envKeys) {
    if (!previousValues.has(key)) {
      previousValues.set(key, process.env[key]);
    }

    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  for (const key of envKeys) {
    const previousValue = previousValues.get(key);
    if (previousValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousValue;
    }
  }

  previousValues.clear();
});

describe("parseContinuousRunnerTargets", () => {
  it("reads the single-target runner config from AUTO_DOC_RUNNER_* env vars", () => {
    setRunnerEnv({
      AUTO_DOC_RUNNER_TARGETS: undefined,
      AUTO_DOC_RUNNER_PROJECT_ID: "project-123",
      AUTO_DOC_RUNNER_REPO_PATH: "C:/repos/manual-creator",
      AUTO_DOC_RUNNER_MODE: "working_tree",
      AUTO_DOC_RUNNER_RELEASE_AUTOMATION: "true",
      AUTO_DOC_RUNNER_RELEASE_AUDIENCE: "both",
      AUTO_DOC_RUNNER_RELEASE_PACKAGE_FORMAT: "markdown",
    });

    expect(parseContinuousRunnerTargets()).toEqual([
      {
        projectId: "project-123",
        repoPath: "C:/repos/manual-creator",
        mode: "working_tree",
        releaseAutomation: true,
        releaseAudience: "both",
        releasePackageFormat: "markdown",
      },
    ]);
  });

  it("reads multiple targets from AUTO_DOC_RUNNER_TARGETS JSON", () => {
    setRunnerEnv({
      AUTO_DOC_RUNNER_TARGETS: JSON.stringify([
        {
          projectId: "project-a",
          repoPath: "/repo/a",
          mode: "last_commit",
        },
        {
          projectId: "project-b",
          repoPath: "/repo/b",
          releaseAutomation: false,
        },
      ]),
      AUTO_DOC_RUNNER_PROJECT_ID: undefined,
      AUTO_DOC_RUNNER_REPO_PATH: undefined,
      AUTO_DOC_RUNNER_MODE: undefined,
      AUTO_DOC_RUNNER_RELEASE_AUTOMATION: undefined,
      AUTO_DOC_RUNNER_RELEASE_AUDIENCE: undefined,
      AUTO_DOC_RUNNER_RELEASE_PACKAGE_FORMAT: undefined,
    });

    expect(parseContinuousRunnerTargets()).toEqual([
      {
        projectId: "project-a",
        repoPath: "/repo/a",
        mode: "last_commit",
      },
      {
        projectId: "project-b",
        repoPath: "/repo/b",
        releaseAutomation: false,
      },
    ]);
  });

  it("defaults per-target timeout to the configured provider timeout when runner timeout is unset", () => {
    setRunnerEnv({
      AUTO_DOC_RUNNER_TARGETS: undefined,
      AUTO_DOC_RUNNER_PROJECT_ID: "project-123",
      AUTO_DOC_RUNNER_REPO_PATH: "C:/repos/manual-creator",
      AUTO_DOC_RUNNER_MODE: "last_commit",
      AUTO_DOC_RUNNER_RELEASE_AUTOMATION: undefined,
      AUTO_DOC_RUNNER_RELEASE_AUDIENCE: undefined,
      AUTO_DOC_RUNNER_RELEASE_PACKAGE_FORMAT: undefined,
      AUTO_DOC_RUNTIME_MODE: "runner",
      NOTION_TOKEN: "test-notion-token",
      STATE_ENCRYPTION_KEY: "test-state-key-not-a-real-secret",
      AI_TIMEOUT_MS: "90000",
      RUNNER_TARGET_TIMEOUT_MS: undefined,
    });

    expect(parseContinuousRunnerConfig().perTargetTimeoutMs).toBe(90000);
  });

  it("uses production-safe provider timeout and real OpenRouter fallback model defaults when unset", () => {
    setRunnerEnv({
      AUTO_DOC_RUNNER_TARGETS: undefined,
      AUTO_DOC_RUNNER_PROJECT_ID: "project-123",
      AUTO_DOC_RUNNER_REPO_PATH: "C:/repos/manual-creator",
      AUTO_DOC_RUNNER_MODE: "last_commit",
      AUTO_DOC_RUNTIME_MODE: "runner",
      NOTION_TOKEN: "test-notion-token",
      STATE_ENCRYPTION_KEY: "test-state-key-not-a-real-secret",
      AI_TIMEOUT_MS: undefined,
      AI_CLOUD_FALLBACK_MODEL: undefined,
      AI_CLOUD_FALLBACK_MODELS: undefined,
      RUNNER_TARGET_TIMEOUT_MS: undefined,
    });

    const runtime = getOptionalRuntimeConfig();

    expect(runtime.provider.timeoutMs).toBe(90000);
    expect(runtime.runner.perTargetTimeoutMs).toBeGreaterThanOrEqual(runtime.provider.timeoutMs);
    expect(runtime.provider.cloudFallbackModel).toBe("qwen/qwen3-next-80b-a3b-instruct:free");
    expect(runtime.provider.cloudFallbackModels).toEqual([
      "qwen/qwen3-next-80b-a3b-instruct:free",
      "qwen/qwen3-next-80b-a3b-instruct",
      "qwen/qwen3-coder-flash",
    ]);
  });

  it("parses the ordered cloud fallback model list and caps it to three rungs", () => {
    setRunnerEnv({
      AI_CLOUD_FALLBACK_MODEL: undefined,
      AI_CLOUD_FALLBACK_MODELS: "first/model, second/model ,third/model,fourth/model",
    });

    const runtime = getOptionalRuntimeConfig();

    expect(runtime.provider.cloudFallbackModels).toEqual(["first/model", "second/model", "third/model"]);
    expect(runtime.provider.cloudFallbackModel).toBe("first/model");
  });

  it("keeps the legacy single cloud fallback model as an alias when the ordered list is unset", () => {
    setRunnerEnv({
      AI_CLOUD_FALLBACK_MODEL: "legacy/model",
      AI_CLOUD_FALLBACK_MODELS: undefined,
    });

    const runtime = getOptionalRuntimeConfig();

    expect(runtime.provider.cloudFallbackModels).toEqual(["legacy/model"]);
    expect(runtime.provider.cloudFallbackModel).toBe("legacy/model");
  });
});
