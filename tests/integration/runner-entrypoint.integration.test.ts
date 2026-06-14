import { describe, expect, it, vi } from "vitest";

const runnerEvents = vi.hoisted(() => ({
  constructedConfigs: [] as unknown[],
  startCalls: 0,
  stopCalls: 0,
}));

vi.mock("../../src/runner/continuous-documentation-runner.js", () => {
  class ContinuousDocumentationRunner {
    constructor(config: unknown) {
      runnerEvents.constructedConfigs.push(config);
    }

    async start() {
      runnerEvents.startCalls += 1;
      return { running: true, completedTicks: 1 };
    }

    async stop() {
      runnerEvents.stopCalls += 1;
      return { running: false };
    }
  }

  return { ContinuousDocumentationRunner };
});

describe("continuous runner entrypoint", () => {
  it("constructs and starts the continuous runner with parsed config", async () => {
    runnerEvents.constructedConfigs.length = 0;
    runnerEvents.startCalls = 0;
    runnerEvents.stopCalls = 0;

    const { runContinuousDocumentationRunner } = await import("../../src/runner/index.js");

    const runner = await runContinuousDocumentationRunner({
      NOTION_TOKEN: "test_token",
      AUTO_DOC_RUNNER_PROJECT_ID: "project_1",
      AUTO_DOC_RUNNER_REPO_PATH: "C:/repo",
      AUTO_DOC_RUNNER_MODE: "last_commit",
      RUNNER_TICK_MS: "1000",
    } as NodeJS.ProcessEnv);

    expect(runnerEvents.constructedConfigs).toHaveLength(1);
    expect(runnerEvents.constructedConfigs[0]).toMatchObject({
      pollIntervalMs: 1000,
      targets: [{ projectId: "project_1", repoPath: "C:/repo", mode: "last_commit" }],
    });
    expect(runnerEvents.startCalls).toBe(1);
    expect(runner).toBeDefined();
  });
});
