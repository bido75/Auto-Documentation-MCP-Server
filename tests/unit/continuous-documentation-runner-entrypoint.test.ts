import { describe, expect, it } from "vitest";
import { parseContinuousRunnerConfig } from "../../src/runner/index.js";

describe("parseContinuousRunnerConfig", () => {
  it("parses a single runner target from environment variables", () => {
    const config = parseContinuousRunnerConfig({
      NOTION_TOKEN: "token",
      AUTO_DOC_RUNNER_PROJECT_ID: "proj_1",
      AUTO_DOC_RUNNER_REPO_PATH: "C:/repo",
      AUTO_DOC_RUNNER_MODE: "last_commit",
      AUTO_DOC_RUNNER_POLL_INTERVAL_MS: "1500",
      AUTO_DOC_RUNNER_TRACE_ID: "trace_1",
    });

    expect(config).toEqual({
      pollIntervalMs: 1500,
      maxConcurrentTargets: 4,
      maxConsecutiveFailures: 5,
      circuitResetAfterMs: 300000,
      perTargetTimeoutMs: 60000,
      targets: [{ projectId: "proj_1", repoPath: "C:/repo", mode: "last_commit" }],
      traceId: "trace_1",
    });
  });

  it("parses explicit JSON targets when provided", () => {
    const config = parseContinuousRunnerConfig({
      NOTION_TOKEN: "token",
      AUTO_DOC_RUNNER_TARGETS: JSON.stringify([
        { projectId: "proj_1", repoPath: "C:/repo1" },
        { projectId: "proj_2", repoPath: "C:/repo2", mode: "staged" },
      ]),
    });

    expect(config.pollIntervalMs).toBe(30_000);
    expect(config.maxConcurrentTargets).toBe(4);
    expect(config.maxConsecutiveFailures).toBe(5);
    expect(config.targets).toEqual([
      { projectId: "proj_1", repoPath: "C:/repo1" },
      { projectId: "proj_2", repoPath: "C:/repo2", mode: "staged" },
    ]);
  });

  it("parses release automation settings from single-target environment variables", () => {
    const config = parseContinuousRunnerConfig({
      NOTION_TOKEN: "token",
      AUTO_DOC_RUNNER_PROJECT_ID: "proj_1",
      AUTO_DOC_RUNNER_REPO_PATH: "C:/repo",
      AUTO_DOC_RUNNER_RELEASE_AUTOMATION: "true",
      AUTO_DOC_RUNNER_RELEASE_PR_URL: "https://github.com/acme/app/pull/42",
      AUTO_DOC_RUNNER_RELEASE_AUDIENCE: "both",
      AUTO_DOC_RUNNER_RELEASE_PACKAGE_FORMAT: "markdown",
      AUTO_DOC_RUNNER_RELEASE_PDF_OUTPUT_PATH: "artifacts/release.pdf",
      AUTO_DOC_RUNNER_RELEASE_LOCAL_DOCS_OUTPUT_PATH: "docs/MANUAL.md",
      AUTO_DOC_RUNNER_RELEASE_HELP_CENTER_OUTPUT_PATH: "docs/help-center.json",
    });

    expect(config.targets).toEqual([
      {
        projectId: "proj_1",
        repoPath: "C:/repo",
        releaseAutomation: true,
        releasePrUrl: "https://github.com/acme/app/pull/42",
        releaseAudience: "both",
        releasePackageFormat: "markdown",
        releasePdfOutputPath: "artifacts/release.pdf",
        releaseLocalDocsOutputPath: "docs/MANUAL.md",
        releaseHelpCenterOutputPath: "docs/help-center.json",
      },
    ]);
    expect(config.maxConsecutiveFailures).toBe(5);
  });
});