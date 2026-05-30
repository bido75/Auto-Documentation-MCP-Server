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

describe("get_runner_failure_triage_metadata", () => {
  it("returns current triage metadata and recent history", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-runner-triage-read-tool-"));
    testContext.store = new StateStore(join(stateDir, "state.json"));

    await testContext.store.setRunnerFailureTriageMetadata("proj_1", "C:/repo", {
      acknowledgedAt: "2026-05-26T07:00:00.000Z",
      acknowledgedBy: "ops@example.com",
      note: "Known incident",
      cooldownUntil: "2026-05-26T10:00:00.000Z",
    });
    await testContext.store.clearRunnerFailureTriageMetadata("proj_1", "C:/repo");
    await testContext.store.setRunnerFailureTriageMetadata("proj_1", "C:/repo", {
      cooldownUntil: "2026-05-26T12:00:00.000Z",
      note: "Retry after vendor maintenance",
    });

    const server = new FakeServer();
    const { registerGetRunnerFailureTriageMetadataTool } = await import("../../src/tools/get-runner-failure-triage-metadata.js");
    registerGetRunnerFailureTriageMetadataTool(server as never);

    const handler = server.handlers.get("get_runner_failure_triage_metadata");
    expect(handler).toBeDefined();

    const result = parseToolResult<{
      projectId: string;
      repoPath: string;
      historyView: string;
      sortOrder: string;
      responseMode: string;
      triageMetadata: {
        cooldownUntil?: string;
        note?: string;
      } | null;
      historyCount: number;
      totalHistoryCount: number;
      lastAcknowledgement: {
        acknowledgedAt: string | null;
        acknowledgedBy: string | null;
      } | null;
      lastCooldownChange: {
        cooldownUntil: string | null;
      } | null;
      recentHistory: Array<{
        action: string;
        metadata: Record<string, unknown> | null;
      }>;
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        limit: 5,
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.repoPath).toBe("C:/repo");
    expect(result.historyView).toBe("all");
    expect(result.sortOrder).toBe("desc");
    expect(result.responseMode).toBe("standard");
    expect(result.triageMetadata).toEqual({
      cooldownUntil: "2026-05-26T12:00:00.000Z",
      note: "Retry after vendor maintenance",
    });
    expect(result.historyCount).toBe(3);
    expect(result.totalHistoryCount).toBe(3);
    expect(result.lastAcknowledgement).toEqual(
      expect.objectContaining({
        acknowledgedAt: "2026-05-26T07:00:00.000Z",
        acknowledgedBy: "ops@example.com",
      }),
    );
    expect(result.lastCooldownChange).toEqual(
      expect.objectContaining({
        cooldownUntil: "2026-05-26T12:00:00.000Z",
      }),
    );
    expect(result.recentHistory).toHaveLength(3);
    expect(result.recentHistory[0]?.action).toBe("set");
    expect(result.recentHistory[1]?.action).toBe("clear");
    expect(result.recentHistory[2]?.action).toBe("set");

    const ascendingView = parseToolResult<{
      sortOrder: string;
      recentHistory: Array<{ action: string; metadata: { acknowledgedBy?: string } | null }>;
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        sortOrder: "asc",
        limit: 5,
      }),
    );

    expect(ascendingView.sortOrder).toBe("asc");
    expect(ascendingView.recentHistory[0]?.action).toBe("set");
    expect(ascendingView.recentHistory[0]?.metadata?.acknowledgedBy).toBe("ops@example.com");
    expect(ascendingView.recentHistory[2]?.action).toBe("set");

    const acknowledgementView = parseToolResult<{
      historyView: string;
      sortOrder: string;
      historyCount: number;
      recentHistory: Array<{ action: string; metadata: { acknowledgedBy?: string } | null }>;
      lastAcknowledgement: { acknowledgedBy: string | null } | null;
      lastCooldownChange: { cooldownUntil: string | null } | null;
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        historyView: "acknowledgement_only",
        limit: 5,
      }),
    );

    expect(acknowledgementView.historyView).toBe("acknowledgement_only");
    expect(acknowledgementView.sortOrder).toBe("desc");
    expect(acknowledgementView.historyCount).toBe(1);
    expect(acknowledgementView.recentHistory[0]?.metadata?.acknowledgedBy).toBe("ops@example.com");
    expect(acknowledgementView.lastAcknowledgement?.acknowledgedBy).toBe("ops@example.com");
    expect(acknowledgementView.lastCooldownChange?.cooldownUntil).toBe("2026-05-26T10:00:00.000Z");

    const cooldownView = parseToolResult<{
      historyView: string;
      sortOrder: string;
      historyCount: number;
      recentHistory: Array<{ action: string }>;
      lastCooldownChange: { cooldownUntil: string | null } | null;
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        historyView: "cooldown_change_only",
        limit: 5,
      }),
    );

    expect(cooldownView.historyView).toBe("cooldown_change_only");
    expect(cooldownView.sortOrder).toBe("desc");
    expect(cooldownView.historyCount).toBe(3);
    expect(cooldownView.recentHistory[0]?.action).toBe("set");
    expect(cooldownView.recentHistory[1]?.action).toBe("clear");
    expect(cooldownView.lastCooldownChange?.cooldownUntil).toBe("2026-05-26T12:00:00.000Z");

    const timelineView = parseToolResult<{
      responseMode: string;
      timelineLabels: string[];
      timeline: {
        eventCount: number;
        labels: {
          acknowledged: number;
          cooldown_set: number;
          cleared: number;
        };
        events: Array<{
          labels: string[];
        }>;
      };
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        responseMode: "timeline",
        limit: 5,
      }),
    );

    expect(timelineView.responseMode).toBe("timeline");
    expect(timelineView.timelineLabels).toEqual([]);
    expect(timelineView.timeline.eventCount).toBe(3);
    expect(timelineView.timeline.labels.acknowledged).toBe(1);
    expect(timelineView.timeline.labels.cooldown_set).toBe(2);
    expect(timelineView.timeline.labels.cleared).toBe(1);
    expect(timelineView.timeline.events.some((event) => event.labels.includes("acknowledged"))).toBe(true);
    expect(timelineView.timeline.events.some((event) => event.labels.includes("cooldown_set"))).toBe(true);
    expect(timelineView.timeline.events.some((event) => event.labels.includes("cleared"))).toBe(true);

    const clearedTimelineView = parseToolResult<{
      responseMode: string;
      timelineLabels: string[];
      timeline: {
        eventCount: number;
        labels: {
          acknowledged: number;
          cooldown_set: number;
          cleared: number;
        };
        events: Array<{
          labels: string[];
        }>;
      };
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        responseMode: "timeline",
        timelineLabels: ["cleared"],
        limit: 5,
      }),
    );

    expect(clearedTimelineView.responseMode).toBe("timeline");
    expect(clearedTimelineView.timelineLabels).toEqual(["cleared"]);
    expect(clearedTimelineView.timeline.eventCount).toBe(1);
    expect(clearedTimelineView.timeline.labels.acknowledged).toBe(0);
    expect(clearedTimelineView.timeline.labels.cooldown_set).toBe(0);
    expect(clearedTimelineView.timeline.labels.cleared).toBe(1);
    expect(clearedTimelineView.timeline.events.every((event) => event.labels.includes("cleared"))).toBe(true);

    const cooldownClearedTimelineView = parseToolResult<{
      historyView: string;
      sortOrder: string;
      historyCount: number;
      responseMode: string;
      timelineLabels: string[];
      timeline: {
        eventCount: number;
        labels: {
          acknowledged: number;
          cooldown_set: number;
          cleared: number;
        };
        events: Array<{
          labels: string[];
        }>;
      };
    }>(
      await handler!({
        projectId: "proj_1",
        repoPath: "C:/repo",
        historyView: "cooldown_change_only",
        responseMode: "timeline",
        timelineLabels: ["cleared"],
        limit: 5,
      }),
    );

    expect(cooldownClearedTimelineView.historyView).toBe("cooldown_change_only");
    expect(cooldownClearedTimelineView.sortOrder).toBe("desc");
    expect(cooldownClearedTimelineView.historyCount).toBe(3);
    expect(cooldownClearedTimelineView.responseMode).toBe("timeline");
    expect(cooldownClearedTimelineView.timelineLabels).toEqual(["cleared"]);
    expect(cooldownClearedTimelineView.timeline.eventCount).toBe(1);
    expect(cooldownClearedTimelineView.timeline.labels.acknowledged).toBe(0);
    expect(cooldownClearedTimelineView.timeline.labels.cooldown_set).toBe(0);
    expect(cooldownClearedTimelineView.timeline.labels.cleared).toBe(1);
    expect(cooldownClearedTimelineView.timeline.events.every((event) => event.labels.includes("cleared"))).toBe(true);
  }, 15_000);
});