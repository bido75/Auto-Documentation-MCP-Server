import { afterEach, describe, expect, it } from "vitest";
import { parseContinuousRunnerTargets } from "../../src/runner/index.js";

const envKeys = [
  "AUTO_DOC_RUNNER_TARGETS",
  "AUTO_DOC_RUNNER_PROJECT_ID",
  "AUTO_DOC_RUNNER_REPO_PATH",
  "AUTO_DOC_RUNNER_MODE",
  "AUTO_DOC_RUNNER_RELEASE_AUTOMATION",
  "AUTO_DOC_RUNNER_RELEASE_AUDIENCE",
  "AUTO_DOC_RUNNER_RELEASE_PACKAGE_FORMAT",
] as const;

const previousValues = new Map<(typeof envKeys)[number], string | undefined>();

function setRunnerEnv(values: Record<(typeof envKeys)[number], string | undefined>): void {
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
});