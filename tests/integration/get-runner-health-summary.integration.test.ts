import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";

const testContext = vi.hoisted(() => {
  return {
    store: null as StateStore | null,
  };
});

vi.mock("../../src/lib/state-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/state-store.js")>("../../src/lib/state-store.js");
  return {
    ...actual,
    getStateStore: () => {
      if (!testContext.store) {
        throw new Error("Test store not initialized");
      }

      return testContext.store;
    },
  };
});

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) {
    this.handlers.set(name, handler);
  }
}

function parseToolResult<T>(value: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(value.content[0].text) as T;
}

describe("get_runner_health_summary", () => {
  it("aggregates health and sorts failing targets by newest failure then streak", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-health-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    const now = Date.now();
    const proj1SuccessAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
    const proj2FailureAt = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    const proj5LatestFailureAt = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    const proj5OlderFailureAt = new Date(now - 3 * 60 * 60 * 1000 - 60_000).toISOString();
    const proj6LatestFailureAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const proj6AcknowledgedAt = new Date(now - 60 * 60 * 1000).toISOString();
    const proj6CooldownUntil = new Date(now + 4 * 60 * 60 * 1000).toISOString();

    await testContext.store.setLastSeenReleaseTag("proj_1", "C:/repo-1", "v1.0.0");
    await testContext.store.setReleaseAutomationRun({
      projectId: "proj_1",
      repoPath: "C:/repo-1",
      releaseTag: "v1.0.0",
      releaseVersion: "1.0.0",
      status: "success",
      attemptedAt: proj1SuccessAt,
    });

    await testContext.store.setReleaseAutomationRun({
      projectId: "proj_2",
      repoPath: "C:/repo-2",
      releaseTag: "v2.0.0",
      releaseVersion: "2.0.0",
      status: "failure",
      attemptedAt: proj2FailureAt,
      errorMessage: "pipeline failed",
    });

    await testContext.store.setReleaseAutomationRun({
      projectId: "proj_5",
      repoPath: "C:/repo-5",
      releaseTag: "v5.1.0",
      releaseVersion: "5.1.0",
      status: "failure",
      attemptedAt: proj5LatestFailureAt,
      errorMessage: "newer failure",
    });
    await testContext.store.setReleaseAutomationRun({
      projectId: "proj_5",
      repoPath: "C:/repo-5",
      releaseTag: "v5.0.0",
      releaseVersion: "5.0.0",
      status: "failure",
      attemptedAt: proj5OlderFailureAt,
      errorMessage: "older failure",
    });

    await testContext.store.setReleaseAutomationRun({
      projectId: "proj_6",
      repoPath: "C:/repo-6",
      releaseTag: "v6.0.0",
      releaseVersion: "6.0.0",
      status: "failure",
      attemptedAt: proj6LatestFailureAt,
      errorMessage: "latest failure",
    });
    await testContext.store.setRunnerFailureTriageMetadata("proj_6", "C:/repo-6", {
      acknowledgedAt: proj6AcknowledgedAt,
      acknowledgedBy: "ops@example.com",
      note: "Known outage under investigation",
      cooldownUntil: proj6CooldownUntil,
    });

    const server = new FakeServer();
    const { registerGetRunnerHealthSummaryTool } = await import("../../src/tools/get-runner-health-summary.js");
    registerGetRunnerHealthSummaryTool(server as never);

    const handler = server.handlers.get("get_runner_health_summary");
    expect(handler).toBeDefined();

    const result = parseToolResult<{
      source: string;
      targetCount: number;
      counts: {
        healthy: number;
        failing: number;
        noData: number;
        disabled: number;
      };
      triage: {
        criticalCount: number;
        highCount: number;
        mediumCount: number;
        lowCount: number;
        staleFailureCount: number;
        escalationCount: number;
        acknowledgedCount: number;
        cooldownActiveCount: number;
        newestFailureAt: string | null;
        oldestFailureAt: string | null;
        highestPriorityCount: number;
        highestPriorityLimit: number;
        staleFailureMinutesThreshold: number;
        escalationFailureStreakThreshold: number;
      };
      failingTargets: Array<{
        projectId: string;
        repoPath: string;
        releaseTag: string | null;
        failureStreak: number;
        lastSuccessAt: string | null;
        minutesSinceFailure: number | null;
        stale: boolean;
        escalated: boolean;
        acknowledged: boolean;
        acknowledgedAt: string | null;
        acknowledgedBy: string | null;
        cooldownUntil: string | null;
        cooldownActive: boolean;
        note: string | null;
        priorityScore: number;
        deprioritized: boolean;
        severity: string;
        severityScore: number;
      }>;
      highestPriorityTargets: Array<{
        projectId: string;
        escalated: boolean;
        priorityScore: number;
        deprioritized: boolean;
      }>;
      targets: Array<{ projectId: string; status: string }>;
    }>(
      await handler!({
        targets: [
          { projectId: "proj_1", repoPath: "C:/repo-1", releaseAutomation: true },
          { projectId: "proj_2", repoPath: "C:/repo-2", releaseAutomation: true },
          { projectId: "proj_3", repoPath: "C:/repo-3", releaseAutomation: false },
          { projectId: "proj_4", repoPath: "C:/repo-4", releaseAutomation: true },
          { projectId: "proj_5", repoPath: "C:/repo-5", releaseAutomation: true },
          { projectId: "proj_6", repoPath: "C:/repo-6", releaseAutomation: true },
        ],
        highestPriorityLimit: 2,
        staleFailureMinutesThreshold: 30,
        escalationFailureStreakThreshold: 2,
      }),
    );

    expect(result.source).toBe("input");
    expect(result.targetCount).toBe(6);
    expect(result.counts.healthy).toBe(1);
    expect(result.counts.failing).toBe(3);
    expect(result.counts.disabled).toBe(1);
    expect(result.counts.noData).toBe(1);
    expect(typeof result.triage).toBe("object");
    expect(result.triage.newestFailureAt).toBe(proj6LatestFailureAt);
    expect(result.triage.oldestFailureAt).toBe(proj2FailureAt);
    expect(typeof result.triage.staleFailureCount).toBe("number");
    expect(typeof result.triage.escalationCount).toBe("number");
    expect(typeof result.triage.acknowledgedCount).toBe("number");
    expect(typeof result.triage.cooldownActiveCount).toBe("number");
    expect(result.triage.highestPriorityCount).toBe(2);
    expect(result.triage.highestPriorityLimit).toBe(2);
    expect(result.triage.staleFailureMinutesThreshold).toBe(30);
    expect(result.triage.escalationFailureStreakThreshold).toBe(2);
    expect(result.failingTargets).toHaveLength(3);
    expect(result.highestPriorityTargets).toHaveLength(2);
    expect(result.failingTargets[0]).toEqual(
      expect.objectContaining({
        projectId: "proj_6",
        repoPath: "C:/repo-6",
        releaseTag: "v6.0.0",
        acknowledged: true,
        cooldownActive: true,
        deprioritized: true,
      }),
    );
    expect(result.failingTargets[1]).toEqual(
      expect.objectContaining({
        projectId: "proj_5",
        repoPath: "C:/repo-5",
        releaseTag: "v5.1.0",
        failureStreak: 2,
        lastSuccessAt: null,
      }),
    );
    expect(result.failingTargets[2]).toEqual(
      expect.objectContaining({
        projectId: "proj_2",
        repoPath: "C:/repo-2",
        releaseTag: "v2.0.0",
      }),
    );
    expect(typeof result.failingTargets[0]?.severity).toBe("string");
    expect(typeof result.failingTargets[0]?.severityScore).toBe("number");
    expect(typeof result.failingTargets[0]?.minutesSinceFailure).toBe("number");
    expect(typeof result.failingTargets[0]?.stale).toBe("boolean");
    expect(typeof result.failingTargets[0]?.escalated).toBe("boolean");
    expect(typeof result.failingTargets[0]?.priorityScore).toBe("number");
    expect(result.failingTargets.some((target) => target.stale)).toBe(true);
    expect(result.failingTargets.some((target) => target.escalated)).toBe(true);
    expect(result.highestPriorityTargets[0]?.projectId).toBe("proj_5");
    expect(result.highestPriorityTargets.every((target) => target.escalated)).toBe(true);
    expect(result.targets.find((target) => target.projectId === "proj_1")?.status).toBe("healthy");
    expect(result.targets.find((target) => target.projectId === "proj_2")?.status).toBe("failing");
  }, 15000);

  it("falls back to env-configured runner targets", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-health-env-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.setLastSeenReleaseTag("proj_env", "C:/repo-env", "v9.0.0");
    await testContext.store.setReleaseAutomationRun({
      projectId: "proj_env",
      repoPath: "C:/repo-env",
      releaseTag: "v9.0.0",
      releaseVersion: "9.0.0",
      status: "success",
      attemptedAt: "2026-05-26T03:00:00.000Z",
    });

    const previousTargets = process.env.AUTO_DOC_RUNNER_TARGETS;
    delete process.env.AUTO_DOC_RUNNER_PROJECT_ID;
    delete process.env.AUTO_DOC_RUNNER_REPO_PATH;
    process.env.AUTO_DOC_RUNNER_TARGETS = JSON.stringify([
      {
        projectId: "proj_env",
        repoPath: "C:/repo-env",
        releaseAutomation: true,
      },
    ]);

    try {
      const server = new FakeServer();
      const { registerGetRunnerHealthSummaryTool } = await import("../../src/tools/get-runner-health-summary.js");
      registerGetRunnerHealthSummaryTool(server as never);

      const handler = server.handlers.get("get_runner_health_summary");
      expect(handler).toBeDefined();

      const result = parseToolResult<{
        source: string;
        targetCount: number;
        counts: { healthy: number };
      }>(
        await handler!({
          includeTargets: false,
        }),
      );

      expect(result.source).toBe("env");
      expect(result.targetCount).toBe(1);
      expect(result.counts.healthy).toBe(1);
    } finally {
      if (previousTargets === undefined) {
        delete process.env.AUTO_DOC_RUNNER_TARGETS;
      } else {
        process.env.AUTO_DOC_RUNNER_TARGETS = previousTargets;
      }
    }
  });
});
