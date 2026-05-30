import { describe, expect, it, vi } from "vitest";
import { ContinuousDocumentationRunner } from "../../src/runner/continuous-documentation-runner.js";

describe("ContinuousDocumentationRunner", () => {
  it("runs configured targets and stops gracefully", async () => {
    const executor = vi.fn(async ({ projectId }: { projectId: string }) => ({
      traceId: "trace_1",
      projectId,
      eventId: "event_1",
      status: "documented" as const,
      diffSummaryLength: 12,
      analyzed: null,
      upserted: null,
    }));

    const runner = new ContinuousDocumentationRunner(
      {
        pollIntervalMs: 10,
        targets: [{ projectId: "proj_1", repoPath: "C:/repo" }],
        traceId: "runner_trace",
      },
      executor as never,
    );

    const started = await runner.start();
    expect(started.running).toBe(true);
    expect(started.stopped).toBe(false);
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        repoPath: "C:/repo",
        mode: "working_tree",
        traceId: "runner_trace",
      }),
    );

    const snapshot = await runner.stop();
    expect(snapshot.running).toBe(false);
    expect(snapshot.stopped).toBe(true);
    expect(snapshot.completedTicks).toBeGreaterThanOrEqual(1);
  });

  it("records failures per target without stopping the runner", async () => {
    const executor = vi.fn(async ({ projectId }: { projectId: string }) => {
      if (projectId === "proj_2") {
        throw new Error("boom");
      }

      return {
        traceId: "trace_1",
        projectId,
        eventId: "event_1",
        status: "documented" as const,
        diffSummaryLength: 3,
        analyzed: null,
        upserted: null,
      };
    });

    const runner = new ContinuousDocumentationRunner(
      {
        pollIntervalMs: 10,
        targets: [
          { projectId: "proj_1", repoPath: "C:/repo1" },
          { projectId: "proj_2", repoPath: "C:/repo2", mode: "last_commit" },
        ],
      },
      executor as never,
    );

    await runner.start();
    const snapshot = runner.getSnapshot();

    expect(snapshot.lastResults).toHaveLength(2);
    expect(snapshot.lastResults[0]?.result?.status).toBe("documented");
    expect(snapshot.lastResults[1]?.result).toBeNull();
    expect(snapshot.lastResults[1]?.error).toContain("boom");

    await runner.stop();
  });

  it("runs release pipeline once when a new release tag is detected", async () => {
    const executor = vi.fn(async ({ projectId }: { projectId: string }) => ({
      traceId: "trace_1",
      projectId,
      eventId: "event_1",
      status: "documented" as const,
      diffSummaryLength: 12,
      analyzed: null,
      upserted: null,
    }));

    const resolveLatestTag = vi.fn(async () => "v2.1.0");
    const releasePipelineRunner = vi.fn(async ({ releaseVersion }: { releaseVersion: string }) => ({
      releaseVersion,
      status: "ok",
    }));

    const storedTags = new Map<string, string>();
    const fakeStateStore = {
      getLastSeenReleaseTag: vi.fn(async (projectId: string, repoPath: string) => storedTags.get(`${projectId}::${repoPath}`) ?? null),
      setLastSeenReleaseTag: vi.fn(async (projectId: string, repoPath: string, tag: string) => {
        storedTags.set(`${projectId}::${repoPath}`, tag);
      }),
      setReleaseAutomationRun: vi.fn(async () => {}),
    };

    const runner = new ContinuousDocumentationRunner(
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
      fakeStateStore as never,
    );

    await runner.start();
    const snapshot = runner.getSnapshot();

    expect(resolveLatestTag).toHaveBeenCalledWith("C:/repo");
    expect(releasePipelineRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        releaseVersion: "2.1.0",
      }),
    );
    expect(snapshot.lastResults[0]?.releaseTag).toBe("v2.1.0");
    expect(snapshot.lastResults[0]?.releasePipeline).toEqual(
      expect.objectContaining({ releaseVersion: "2.1.0", status: "ok" }),
    );
    expect(fakeStateStore.setReleaseAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        repoPath: "C:/repo",
        releaseTag: "v2.1.0",
        status: "success",
      }),
    );

    await runner.stop();
  });

  it("does not rerun release pipeline when tag is unchanged", async () => {
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
      .mockResolvedValueOnce("v2.1.0")
      .mockResolvedValueOnce("v2.1.0");

    const releasePipelineRunner = vi.fn(async ({ releaseVersion }: { releaseVersion: string }) => ({
      releaseVersion,
      status: "ok",
    }));

    const storedTags = new Map<string, string>();
    const fakeStateStore = {
      getLastSeenReleaseTag: vi.fn(async (projectId: string, repoPath: string) => storedTags.get(`${projectId}::${repoPath}`) ?? null),
      setLastSeenReleaseTag: vi.fn(async (projectId: string, repoPath: string, tag: string) => {
        storedTags.set(`${projectId}::${repoPath}`, tag);
      }),
      setReleaseAutomationRun: vi.fn(async () => {}),
    };

    const runner = new ContinuousDocumentationRunner(
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
      fakeStateStore as never,
    );

    await runner.start();
    await runner.stop();
    await runner.start();

    expect(releasePipelineRunner).toHaveBeenCalledTimes(1);

    await runner.stop();
  });

  it("does not rerun release pipeline after restart when persisted tag matches", async () => {
    const executor = vi.fn(async ({ projectId }: { projectId: string }) => ({
      traceId: "trace_1",
      projectId,
      eventId: "event_1",
      status: "documented" as const,
      diffSummaryLength: 12,
      analyzed: null,
      upserted: null,
    }));

    const resolveLatestTag = vi.fn(async () => "v2.1.0");
    const releasePipelineRunner = vi.fn(async ({ releaseVersion }: { releaseVersion: string }) => ({
      releaseVersion,
      status: "ok",
    }));

    const storedTags = new Map<string, string>([["proj_1::C:/repo", "v2.1.0"]]);
    const fakeStateStore = {
      getLastSeenReleaseTag: vi.fn(async (projectId: string, repoPath: string) => storedTags.get(`${projectId}::${repoPath}`) ?? null),
      setLastSeenReleaseTag: vi.fn(async (projectId: string, repoPath: string, tag: string) => {
        storedTags.set(`${projectId}::${repoPath}`, tag);
      }),
      setReleaseAutomationRun: vi.fn(async () => {}),
    };

    const runner = new ContinuousDocumentationRunner(
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
      fakeStateStore as never,
    );

    await runner.start();

    expect(fakeStateStore.getLastSeenReleaseTag).toHaveBeenCalledWith("proj_1", "C:/repo");
    expect(releasePipelineRunner).toHaveBeenCalledTimes(0);
    expect(fakeStateStore.setLastSeenReleaseTag).not.toHaveBeenCalled();

    await runner.stop();
  });
});
