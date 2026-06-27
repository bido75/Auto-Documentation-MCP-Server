import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { ContinuousDocumentationRunner, type ContinuousRunnerConfig } from "../../src/runner/continuous-documentation-runner.js";
import type { AutonomousTriggerInput, AutonomousTriggerResult } from "../../src/orchestrator/auto-doc-orchestrator.js";

describe("prove-real-runner-tick", () => {
  it("start runs the real tick loop, invokes the injected executor, records a target result, and stops cleanly", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-tick-"));
    const previousHealthFile = process.env.AUTO_DOC_HEALTH_FILE;
    process.env.AUTO_DOC_HEALTH_FILE = join(stateDir, "runner-health.json");
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
    try {
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

      const health = JSON.parse(await readFile(process.env.AUTO_DOC_HEALTH_FILE, "utf8")) as {
        status: string;
        lastTickAt: string | null;
        lastSuccessfulTickAt: string | null;
        lastAuthoredFeatureAt: string | null;
        consecutiveZeroAuthoredTicks: number;
      };
      expect(health.status).toBe("healthy");
      expect(health.lastTickAt).toBeTruthy();
      expect(health.lastSuccessfulTickAt).toBeTruthy();
      expect(health.lastAuthoredFeatureAt).toBeTruthy();
      expect(health.consecutiveZeroAuthoredTicks).toBe(0);

      const stopped = await runner.stop();
      expect(stopped.running).toBe(false);
      expect(stopped.stopped).toBe(true);
    } finally {
      if (previousHealthFile === undefined) {
        delete process.env.AUTO_DOC_HEALTH_FILE;
      } else {
        process.env.AUTO_DOC_HEALTH_FILE = previousHealthFile;
      }
    }
  });

  it("uses opt-in Notion discovery recovery for missing project state and retries the target", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-recovery-"));
    const previousEnabled = process.env.AUTO_DOC_DISCOVERY_RECOVERY_ENABLED;
    const previousHints = process.env.AUTO_DOC_DISCOVERY_PAGE_HINTS;
    process.env.AUTO_DOC_DISCOVERY_RECOVERY_ENABLED = "true";
    process.env.AUTO_DOC_DISCOVERY_PAGE_HINTS = JSON.stringify({ project_1: "project_page_1" });

    const calls: string[] = [];
    const recoveryCalls: Array<{ projectId: string; projectPageId: string }> = [];
    const result: AutonomousTriggerResult = {
      ok: true,
      projectId: "project_1",
      repoPath: "C:/repo",
      mode: "last_commit",
      disposition: "documented",
      documentedFeatureCount: 1,
      analyzerFailureCount: 0,
      skippedCount: 0,
      duplicateCount: 0,
      capture: { traceId: "trace", evidenceEventId: "evt_1", evidencePageId: "page_evt_1", initialClassification: "true" },
      analysis: {
        shouldDocument: true,
        featureKey: "feature:runner",
        featureName: "Runner Recovery",
        audiences: ["User"],
        entryTypes: ["User Guide"],
        confidenceScore: 90,
        confidenceReasons: ["Recovered runner test"],
        reviewQuestions: [],
        fallbackStatus: null,
        fallbackEntryId: null,
        fallbackReasonCode: "none",
        traceId: "trace",
      },
      upsert: { featureId: "feature_1", manualEntryIds: ["manual_1"] },
      publish: null,
    };
    const executor = async () => {
      calls.push("executor");
      if (calls.length === 1) {
        throw new Error("Unknown projectId. Run initialize_project_manual first.");
      }
      return result;
    };

    try {
      const runner = new ContinuousDocumentationRunner(
        {
          pollIntervalMs: 60_000,
          targets: [{ projectId: "project_1", repoPath: "C:/repo", mode: "last_commit" }],
          traceId: "runner-recovery-test",
        },
        executor,
        async () => null,
        async () => null,
        new StateStore(join(stateDir, "state.json")),
        async (input) => {
          recoveryCalls.push({ projectId: input.projectId, projectPageId: input.projectPageId });
          return { ok: true, status: "initialized_from_notion" };
        },
      );

      await runner.tick();

      expect(calls).toEqual(["executor", "executor"]);
      expect(recoveryCalls).toEqual([{ projectId: "project_1", projectPageId: "project_page_1" }]);
      expect(runner.getSnapshot().lastResults[0]?.result).toMatchObject({ disposition: "documented" });
    } finally {
      if (previousEnabled === undefined) delete process.env.AUTO_DOC_DISCOVERY_RECOVERY_ENABLED;
      else process.env.AUTO_DOC_DISCOVERY_RECOVERY_ENABLED = previousEnabled;
      if (previousHints === undefined) delete process.env.AUTO_DOC_DISCOVERY_PAGE_HINTS;
      else process.env.AUTO_DOC_DISCOVERY_PAGE_HINTS = previousHints;
    }
  });
});
