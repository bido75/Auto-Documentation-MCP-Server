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

describe("set_runner_failure_triage_metadata", () => {
  it("sets and clears runner failure triage metadata", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-triage-tool-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    const server = new FakeServer();
    const { registerSetRunnerFailureTriageMetadataTool } = await import("../../src/tools/set-runner-failure-triage-metadata.js");
    registerSetRunnerFailureTriageMetadataTool(server as never);

    const handler = server.handlers.get("set_runner_failure_triage_metadata");
    expect(handler).toBeDefined();

    const setResult = parseToolResult<{
      projectId: string;
      repoPath: string;
      action: string;
      triageMetadata: {
        acknowledgedAt: string;
        acknowledgedBy: string;
        note: string;
        cooldownUntil: string;
      };
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        action: "set",
        acknowledge: true,
        acknowledgedAt: "2026-05-26T07:00:00.000Z",
        acknowledgedBy: "ops@example.com",
        note: "Known incident",
        cooldownUntil: "2026-05-26T10:00:00.000Z",
      }),
    );

    expect(setResult.projectId).toBe("proj_1");
    expect(setResult.action).toBe("set");
    expect(setResult.triageMetadata).toEqual({
      acknowledgedAt: "2026-05-26T07:00:00.000Z",
      acknowledgedBy: "ops@example.com",
      note: "Known incident",
      cooldownUntil: "2026-05-26T10:00:00.000Z",
    });

    expect(await testContext.store.getRunnerFailureTriageMetadata("proj_1", "C:/repo")).toEqual(setResult.triageMetadata);

    const clearResult = parseToolResult<{
      projectId: string;
      repoPath: string;
      action: string;
      triageMetadata: null;
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        action: "clear",
      }),
    );

    expect(clearResult.action).toBe("clear");
    expect(clearResult.triageMetadata).toBeNull();
    expect(await testContext.store.getRunnerFailureTriageMetadata("proj_1", "C:/repo")).toBeNull();
  });
});