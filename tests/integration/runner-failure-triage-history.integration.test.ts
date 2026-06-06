import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";
import { registerGetRunnerFailureTriageMetadataTool } from "../../src/tools/get-runner-failure-triage-metadata.js";
import { registerSetRunnerFailureTriageMetadataTool } from "../../src/tools/set-runner-failure-triage-metadata.js";

const testContext = vi.hoisted(() => ({
  store: null as StateStore | null,
}));

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

type ToolResult = { content: Array<{ type: string; text: string }> };

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<ToolResult>>();

  tool(name: string, _description: string, _schema: unknown, handler: (input: unknown) => Promise<ToolResult>): void {
    this.handlers.set(name, handler);
  }
}

function parseToolResult<T>(value: ToolResult): T {
  return JSON.parse(value.content[0]?.text ?? "{}") as T;
}

describe("runner failure triage history", () => {
  it("captures set and clear actions in timeline mode with correct labels and ordering", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-triage-history-"));
    const store = new StateStore(join(stateDir, "state.json"));
    testContext.store = store;

    await store.upsertProject({
      projectId: "proj_triage_1",
      projectName: "Triage History",
      parentPageId: "parent_page",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      databases: {
        projectsDatabaseId: "db_projects",
        featuresDatabaseId: "db_features",
        manualEntriesDatabaseId: "db_entries",
        evidenceEventsDatabaseId: "db_events",
        releasesDatabaseId: "db_releases",
      },
      featuresByKey: {},
      eventsByExternalId: {},
      eventSnapshots: {},
    });

    const server = new FakeServer();
    registerSetRunnerFailureTriageMetadataTool(server as never);
    registerGetRunnerFailureTriageMetadataTool(server as never);

    const setHandler = server.handlers.get("set_runner_failure_triage_metadata");
    const getHandler = server.handlers.get("get_runner_failure_triage_metadata");

    expect(setHandler).toBeDefined();
    expect(getHandler).toBeDefined();

    await setHandler!({
      projectId: "proj_triage_1",
      repoPath: ".",
      action: "set",
      acknowledge: true,
      acknowledgedBy: "ci-bot",
      note: "Investigating failure",
      cooldownUntil: "2026-06-06T00:00:00.000Z",
      traceId: "trace-set",
    });

    await setHandler!({
      projectId: "proj_triage_1",
      repoPath: ".",
      action: "clear",
      traceId: "trace-clear",
    });

    const timelineResponse = parseToolResult<{
      historyCount: number;
      totalHistoryCount: number;
      recentHistory: Array<{ action: "set" | "clear" }>;
      timeline: {
        eventCount: number;
        labels: {
          acknowledged: number;
          cooldown_set: number;
          cleared: number;
          note_updated: number;
          metadata_updated: number;
        };
        events: Array<{ action: "set" | "clear"; labels: string[] }>;
      };
    }>(
      await getHandler!({
        projectId: "proj_triage_1",
        repoPath: ".",
        limit: 10,
        responseMode: "timeline",
        sortOrder: "desc",
        historyView: "all",
        traceId: "trace-get",
      }),
    );

    expect(timelineResponse.historyCount).toBe(2);
    expect(timelineResponse.totalHistoryCount).toBe(2);
    expect(timelineResponse.recentHistory[0]?.action).toBe("clear");
    expect(timelineResponse.recentHistory[1]?.action).toBe("set");

    expect(timelineResponse.timeline.eventCount).toBe(2);
    expect(timelineResponse.timeline.labels.cleared).toBe(1);
    expect(timelineResponse.timeline.labels.acknowledged).toBe(1);
    expect(timelineResponse.timeline.labels.cooldown_set).toBe(1);
    expect(timelineResponse.timeline.labels.note_updated).toBe(1);
    expect(timelineResponse.timeline.events[0]?.labels).toContain("cleared");
    expect(timelineResponse.timeline.events[1]?.labels).toContain("acknowledged");
  });

  it("supports timeline label filtering for clear-only event views", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-triage-history-filter-"));
    const store = new StateStore(join(stateDir, "state.json"));
    testContext.store = store;

    await store.upsertProject({
      projectId: "proj_triage_2",
      projectName: "Triage History Filter",
      parentPageId: "parent_page",
      publishingMode: "Balanced",
      autoPublishThreshold: 90,
      databases: {
        projectsDatabaseId: "db_projects",
        featuresDatabaseId: "db_features",
        manualEntriesDatabaseId: "db_entries",
        evidenceEventsDatabaseId: "db_events",
        releasesDatabaseId: "db_releases",
      },
      featuresByKey: {},
      eventsByExternalId: {},
      eventSnapshots: {},
    });

    const server = new FakeServer();
    registerSetRunnerFailureTriageMetadataTool(server as never);
    registerGetRunnerFailureTriageMetadataTool(server as never);

    const setHandler = server.handlers.get("set_runner_failure_triage_metadata");
    const getHandler = server.handlers.get("get_runner_failure_triage_metadata");

    expect(setHandler).toBeDefined();
    expect(getHandler).toBeDefined();

    await setHandler!({
      projectId: "proj_triage_2",
      repoPath: ".",
      action: "set",
      acknowledge: true,
      acknowledgedBy: "operator",
      note: "Ack only",
      traceId: "trace-set-2",
    });

    await setHandler!({
      projectId: "proj_triage_2",
      repoPath: ".",
      action: "clear",
      traceId: "trace-clear-2",
    });

    const filtered = parseToolResult<{
      timeline: { eventCount: number; events: Array<{ action: "set" | "clear"; labels: string[] }> };
    }>(
      await getHandler!({
        projectId: "proj_triage_2",
        repoPath: ".",
        limit: 10,
        responseMode: "timeline",
        timelineLabels: ["cleared"],
        traceId: "trace-filter",
      }),
    );

    expect(filtered.timeline.eventCount).toBe(1);
    expect(filtered.timeline.events[0]?.action).toBe("clear");
    expect(filtered.timeline.events[0]?.labels).toEqual(["cleared"]);
  });
});
