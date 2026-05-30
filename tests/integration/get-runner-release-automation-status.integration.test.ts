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

describe("get_runner_release_automation_status", () => {
  it("returns last-seen tag and recent runs sorted by attemptedAt", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-status-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.setLastSeenReleaseTag("proj_1", "C:/repo", "v3.1.0");
    await testContext.store.setReleaseAutomationRun({
      projectId: "proj_1",
      repoPath: "C:/repo",
      releaseTag: "v3.0.0",
      releaseVersion: "3.0.0",
      status: "success",
      attemptedAt: "2026-05-26T00:00:00.000Z",
    });
    await testContext.store.setReleaseAutomationRun({
      projectId: "proj_1",
      repoPath: "C:/repo",
      releaseTag: "v3.1.0",
      releaseVersion: "3.1.0",
      status: "failure",
      attemptedAt: "2026-05-26T01:00:00.000Z",
      errorMessage: "pipeline failed",
    });

    const server = new FakeServer();
    const { registerGetRunnerReleaseAutomationStatusTool } = await import("../../src/tools/get-runner-release-automation-status.js");
    registerGetRunnerReleaseAutomationStatusTool(server as never);

    const handler = server.handlers.get("get_runner_release_automation_status");
    expect(handler).toBeDefined();

    const result = parseToolResult<{
      projectId: string;
      repoPath: string;
      lastSeenReleaseTag: string | null;
      recentRunCount: number;
      lastSuccessfulRun: { releaseTag: string } | null;
      lastFailedRun: { releaseTag: string; errorMessage?: string } | null;
      recentRuns: Array<{ releaseTag: string }>;
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        limit: 10,
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.repoPath).toBe("C:/repo");
    expect(result.lastSeenReleaseTag).toBe("v3.1.0");
    expect(result.recentRunCount).toBe(2);
    expect(result.recentRuns.map((run) => run.releaseTag)).toEqual(["v3.1.0", "v3.0.0"]);
    expect(result.lastSuccessfulRun?.releaseTag).toBe("v3.0.0");
    expect(result.lastFailedRun?.releaseTag).toBe("v3.1.0");
    expect(result.lastFailedRun?.errorMessage).toBe("pipeline failed");
  });

  it("returns queried run details for specific tag and supports limit", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-status-query-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.setReleaseAutomationRun({
      projectId: "proj_1",
      repoPath: "C:/repo",
      releaseTag: "v3.0.0",
      releaseVersion: "3.0.0",
      status: "success",
      attemptedAt: "2026-05-26T00:00:00.000Z",
    });
    await testContext.store.setReleaseAutomationRun({
      projectId: "proj_1",
      repoPath: "C:/repo",
      releaseTag: "v3.1.0",
      releaseVersion: "3.1.0",
      status: "success",
      attemptedAt: "2026-05-26T01:00:00.000Z",
    });

    const server = new FakeServer();
    const { registerGetRunnerReleaseAutomationStatusTool } = await import("../../src/tools/get-runner-release-automation-status.js");
    registerGetRunnerReleaseAutomationStatusTool(server as never);

    const handler = server.handlers.get("get_runner_release_automation_status");
    expect(handler).toBeDefined();

    const result = parseToolResult<{
      releaseTag: string | null;
      queriedRun: { releaseTag: string } | null;
      recentRuns: Array<{ releaseTag: string }>;
      recentRunCount: number;
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        releaseTag: "v3.0.0",
        limit: 1,
      }),
    );

    expect(result.releaseTag).toBe("v3.0.0");
    expect(result.queriedRun?.releaseTag).toBe("v3.0.0");
    expect(result.recentRunCount).toBe(1);
    expect(result.recentRuns.map((run) => run.releaseTag)).toEqual(["v3.1.0"]);
  });
});
