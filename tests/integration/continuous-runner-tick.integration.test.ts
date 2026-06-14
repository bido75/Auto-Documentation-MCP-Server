import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { ContinuousDocumentationRunner, type ContinuousRunnerConfig } from "../../src/runner/continuous-documentation-runner.js";
import type { AutonomousTriggerInput, AutonomousTriggerResult } from "../../src/orchestrator/auto-doc-orchestrator.js";

describe("prove-real-runner-tick", () => {
  it("start runs the real tick loop, invokes the injected executor, records a target result, and stops cleanly", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-tick-"));
    const calls: Array<{ projectId: string; repoPath?: string; mode: string }> = [];
    const result: AutonomousTriggerResult = {
      ok: true,
      projectId: "project_1",
      repoPath: "C:/repo",
      mode: "last_commit",
      disposition: "documented",
      capture: { traceId: "trace", evidenceEventId: "evt_1", evidencePageId: "page_evt_1", initialClassification: "true" },
      analysis: {
        shouldDocument: true,
        featureKey: "feature:runner",
        featureName: "Runner Tick",
        audiences: ["User"],
        entryTypes: ["User Guide"],
        confidenceScore: 90,
        confidenceReasons: ["Real runner test"],
        reviewQuestions: [],
        fallbackStatus: null,
        fallbackEntryId: null,
        fallbackReasonCode: "none",
        traceId: "trace",
      },
      upsert: { featureId: "feature_1", manualEntryIds: ["manual_1"] },
      publish: {
        traceId: "trace",
        featureId: "feature_1",
        manualEntryIds: ["manual_1"],
        finalStatus: "Published",
        publishingDecision: "Agent Published",
        reviewNotes: "",
      },
    };
    const executor = async (input: AutonomousTriggerInput) => {
      calls.push({ projectId: input.projectId, repoPath: input.repoPath, mode: input.mode });
      return result;
    };
    const config: ContinuousRunnerConfig = {
      pollIntervalMs: 60_000,
      targets: [{ projectId: "project_1", repoPath: "C:/repo", mode: "last_commit" }],
      traceId: "runner-test",
    };
    const runner = new ContinuousDocumentationRunner(
      config,
      executor,
      async () => null,
      async () => null,
      new StateStore(join(stateDir, "state.json")),
    );

    const started = await runner.start();
    expect(started.running).toBe(true);
    expect(started.completedTicks).toBe(1);
    expect(calls).toEqual([{ projectId: "project_1", repoPath: "C:/repo", mode: "last_commit" }]);
    expect(started.lastResults).toHaveLength(1);
    expect(started.lastResults[0]?.result).toMatchObject({ disposition: "documented" });

    const stopped = await runner.stop();
    expect(stopped.running).toBe(false);
    expect(stopped.stopped).toBe(true);
  });
});
