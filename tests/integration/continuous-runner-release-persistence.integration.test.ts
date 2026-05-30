import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { ContinuousDocumentationRunner } from "../../src/runner/continuous-documentation-runner.js";

describe("Continuous runner release-tag persistence", () => {
  it("does not trigger release pipeline again after restart when tag is unchanged", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-persist-"));
    const statePath = join(stateDir, "state.json");

    const executor = vi.fn(async ({ projectId }: { projectId: string }) => ({
      traceId: "trace_1",
      projectId,
      eventId: "event_1",
      status: "documented" as const,
      diffSummaryLength: 12,
      analyzed: null,
      upserted: null,
    }));

    const resolveLatestTag = vi.fn(async () => "v3.0.0");
    const releasePipelineRunner = vi.fn(async ({ releaseVersion }: { releaseVersion: string }) => ({
      releaseVersion,
      status: "ok",
    }));

    const firstRunner = new ContinuousDocumentationRunner(
      {
        pollIntervalMs: 10,
        targets: [
          {
            projectId: "proj_1",
            repoPath: "C:/repo",
            releaseAutomation: true,
            releaseAudience: "both",
          },
        ],
        traceId: "runner_trace",
      },
      executor as never,
      resolveLatestTag,
      releasePipelineRunner,
      new StateStore(statePath),
    );

    await firstRunner.start();
    await firstRunner.stop();

    expect(releasePipelineRunner).toHaveBeenCalledTimes(1);
    expect(releasePipelineRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        releaseVersion: "3.0.0",
      }),
    );

    const secondRunner = new ContinuousDocumentationRunner(
      {
        pollIntervalMs: 10,
        targets: [
          {
            projectId: "proj_1",
            repoPath: "C:/repo",
            releaseAutomation: true,
          },
        ],
        traceId: "runner_trace",
      },
      executor as never,
      resolveLatestTag,
      releasePipelineRunner,
      new StateStore(statePath),
    );

    await secondRunner.start();
    await secondRunner.stop();

    expect(resolveLatestTag).toHaveBeenCalledTimes(2);
    expect(releasePipelineRunner).toHaveBeenCalledTimes(1);
  });

  it("triggers release pipeline exactly once more after restart when tag advances", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-persist-advance-"));
    const statePath = join(stateDir, "state.json");

    const executor = vi.fn(async ({ projectId }: { projectId: string }) => ({
      traceId: "trace_1",
      projectId,
      eventId: "event_1",
      status: "documented" as const,
      diffSummaryLength: 12,
      analyzed: null,
      upserted: null,
    }));

    const resolveLatestTag = vi
      .fn()
      .mockResolvedValueOnce("v3.0.0")
      .mockResolvedValueOnce("v3.1.0");

    const releasePipelineRunner = vi.fn(async ({ releaseVersion }: { releaseVersion: string }) => ({
      releaseVersion,
      status: "ok",
    }));

    const firstRunner = new ContinuousDocumentationRunner(
      {
        pollIntervalMs: 10,
        targets: [
          {
            projectId: "proj_1",
            repoPath: "C:/repo",
            releaseAutomation: true,
          },
        ],
        traceId: "runner_trace",
      },
      executor as never,
      resolveLatestTag,
      releasePipelineRunner,
      new StateStore(statePath),
    );

    await firstRunner.start();
    await firstRunner.stop();

    const secondRunner = new ContinuousDocumentationRunner(
      {
        pollIntervalMs: 10,
        targets: [
          {
            projectId: "proj_1",
            repoPath: "C:/repo",
            releaseAutomation: true,
          },
        ],
        traceId: "runner_trace",
      },
      executor as never,
      resolveLatestTag,
      releasePipelineRunner,
      new StateStore(statePath),
    );

    await secondRunner.start();
    await secondRunner.stop();

    expect(resolveLatestTag).toHaveBeenCalledTimes(2);
    expect(releasePipelineRunner).toHaveBeenCalledTimes(2);
    expect(releasePipelineRunner).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        projectId: "proj_1",
        releaseVersion: "3.0.0",
      }),
    );
    expect(releasePipelineRunner).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectId: "proj_1",
        releaseVersion: "3.1.0",
      }),
    );
  }, 15_000);

  it("retries failed release tag after restart, then does not rerun after successful recovery", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-persist-recovery-"));
    const statePath = join(stateDir, "state.json");
    const stateStore = new StateStore(statePath);

    const executor = vi.fn(async ({ projectId }: { projectId: string }) => ({
      traceId: "trace_1",
      projectId,
      eventId: "event_1",
      status: "documented" as const,
      diffSummaryLength: 12,
      analyzed: null,
      upserted: null,
    }));

    const resolveLatestTag = vi.fn(async () => "v4.0.0");
    const releasePipelineRunner = vi
      .fn()
      .mockRejectedValueOnce(new Error("pipeline failed"))
      .mockResolvedValueOnce({ releaseVersion: "4.0.0", status: "ok" });

    const failingRunner = new ContinuousDocumentationRunner(
      {
        pollIntervalMs: 10,
        targets: [
          {
            projectId: "proj_1",
            repoPath: "C:/repo",
            releaseAutomation: true,
          },
        ],
        traceId: "runner_trace",
      },
      executor as never,
      resolveLatestTag,
      releasePipelineRunner,
      stateStore,
    );

    await failingRunner.start();
    await failingRunner.stop();

    expect(releasePipelineRunner).toHaveBeenCalledTimes(1);
    expect(await stateStore.getLastSeenReleaseTag("proj_1", "C:/repo")).toBeNull();
    expect(await stateStore.getReleaseAutomationRun("proj_1", "C:/repo", "v4.0.0")).toEqual(
      expect.objectContaining({
        status: "failure",
        errorMessage: "pipeline failed",
      }),
    );

    const recoveryRunner = new ContinuousDocumentationRunner(
      {
        pollIntervalMs: 10,
        targets: [
          {
            projectId: "proj_1",
            repoPath: "C:/repo",
            releaseAutomation: true,
          },
        ],
        traceId: "runner_trace",
      },
      executor as never,
      resolveLatestTag,
      releasePipelineRunner,
      new StateStore(statePath),
    );

    await recoveryRunner.start();
    await recoveryRunner.stop();

    expect(releasePipelineRunner).toHaveBeenCalledTimes(2);
    expect(await stateStore.getLastSeenReleaseTag("proj_1", "C:/repo")).toBe("v4.0.0");
    expect(await stateStore.getReleaseAutomationRun("proj_1", "C:/repo", "v4.0.0")).toEqual(
      expect.objectContaining({
        status: "success",
        releaseVersion: "4.0.0",
      }),
    );

    const dedupeRunner = new ContinuousDocumentationRunner(
      {
        pollIntervalMs: 10,
        targets: [
          {
            projectId: "proj_1",
            repoPath: "C:/repo",
            releaseAutomation: true,
          },
        ],
        traceId: "runner_trace",
      },
      executor as never,
      resolveLatestTag,
      releasePipelineRunner,
      new StateStore(statePath),
    );

    await dedupeRunner.start();
    await dedupeRunner.stop();

    expect(releasePipelineRunner).toHaveBeenCalledTimes(2);
  }, 15_000);
});
