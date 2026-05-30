import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { getStateStore, type RunnerFailureTriageHistoryEntry } from "../lib/state-store.js";

type HistoryView = "all" | "acknowledgement_only" | "cooldown_change_only";
type SortOrder = "desc" | "asc";
type ResponseMode = "standard" | "timeline";

type TimelineLabel = "acknowledged" | "cooldown_set" | "cleared" | "note_updated" | "metadata_updated";

const MAX_HISTORY_SCAN_LIMIT = 50;

function findLastAcknowledgement(history: Array<{ changedAt: string; metadata: { acknowledgedAt?: string; acknowledgedBy?: string } | null }>) {
  const entry = history.find((item) => item.metadata?.acknowledgedAt || item.metadata?.acknowledgedBy);
  if (!entry) {
    return null;
  }

  return {
    changedAt: entry.changedAt,
    acknowledgedAt: entry.metadata?.acknowledgedAt ?? null,
    acknowledgedBy: entry.metadata?.acknowledgedBy ?? null,
  };
}

function findLastCooldownChange(history: Array<{ changedAt: string; metadata: { cooldownUntil?: string } | null }>) {
  const entry = history.find((item) => item.metadata?.cooldownUntil || item.metadata === null);
  if (!entry) {
    return null;
  }

  return {
    changedAt: entry.changedAt,
    cooldownUntil: entry.metadata?.cooldownUntil ?? null,
  };
}

function filterHistoryByView(history: RunnerFailureTriageHistoryEntry[], historyView: HistoryView): RunnerFailureTriageHistoryEntry[] {
  if (historyView === "acknowledgement_only") {
    return history.filter((item) => Boolean(item.metadata?.acknowledgedAt) || Boolean(item.metadata?.acknowledgedBy));
  }

  if (historyView === "cooldown_change_only") {
    return history.filter((item) => item.action === "clear" || Boolean(item.metadata?.cooldownUntil));
  }

  return history;
}

function sortHistoryByChangedAt(history: RunnerFailureTriageHistoryEntry[], sortOrder: SortOrder): RunnerFailureTriageHistoryEntry[] {
  const sorted = [...history].sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  return sortOrder === "asc" ? sorted : sorted.reverse();
}

function getTimelineLabels(entry: RunnerFailureTriageHistoryEntry): TimelineLabel[] {
  if (entry.action === "clear") {
    return ["cleared"];
  }

  const labels: TimelineLabel[] = [];
  if (entry.metadata?.acknowledgedAt || entry.metadata?.acknowledgedBy) {
    labels.push("acknowledged");
  }
  if (entry.metadata?.cooldownUntil) {
    labels.push("cooldown_set");
  }
  if (entry.metadata?.note) {
    labels.push("note_updated");
  }

  return labels.length > 0 ? labels : ["metadata_updated"];
}

function toTimelineEvent(entry: RunnerFailureTriageHistoryEntry) {
  return {
    changedAt: entry.changedAt,
    labels: getTimelineLabels(entry),
    action: entry.action,
    acknowledgedAt: entry.metadata?.acknowledgedAt ?? null,
    acknowledgedBy: entry.metadata?.acknowledgedBy ?? null,
    cooldownUntil: entry.metadata?.cooldownUntil ?? null,
    note: entry.metadata?.note ?? null,
  };
}

function filterTimelineEventsByLabels(
  events: Array<ReturnType<typeof toTimelineEvent>>,
  timelineLabels: TimelineLabel[],
): Array<ReturnType<typeof toTimelineEvent>> {
  if (timelineLabels.length === 0) {
    return events;
  }

  const labelSet = new Set(timelineLabels);
  return events.filter((event) => event.labels.some((label) => labelSet.has(label)));
}

export function registerGetRunnerFailureTriageMetadataTool(server: McpServer) {
  server.tool(
    "get_runner_failure_triage_metadata",
    "Reads current runner failure triage metadata and recent metadata update history for a project and repository target.",
    {
      projectId: z.string().min(1),
      repoPath: z.string().min(1),
      limit: z.number().int().min(1).max(50).default(10),
      historyView: z.enum(["all", "acknowledgement_only", "cooldown_change_only"]).default("all"),
      sortOrder: z.enum(["desc", "asc"]).default("desc"),
      responseMode: z.enum(["standard", "timeline"]).default("standard"),
      timelineLabels: z
        .array(z.enum(["acknowledged", "cooldown_set", "cleared", "note_updated", "metadata_updated"]))
        .max(5)
        .optional(),
      traceId: z.string().optional(),
    },
    async ({ projectId, repoPath, limit, historyView, sortOrder, responseMode, timelineLabels, traceId: incomingTraceId }) => {
      const traceId = resolveTraceId(incomingTraceId);
      const startedAt = Date.now();
      const resolvedHistoryView: HistoryView = historyView ?? "all";
      const resolvedSortOrder: SortOrder = sortOrder ?? "desc";
      const resolvedResponseMode: ResponseMode = responseMode ?? "standard";
      const resolvedTimelineLabels = timelineLabels ?? [];

      logToolEvent({
        level: "info",
        tool: "get_runner_failure_triage_metadata",
        stage: "start",
        traceId,
        message: "Fetching runner failure triage metadata",
        data: {
          projectId,
          repoPath,
          limit,
          historyView: resolvedHistoryView,
          sortOrder: resolvedSortOrder,
          responseMode: resolvedResponseMode,
          timelineLabels: resolvedTimelineLabels,
        },
      });

      try {
        const store = getStateStore();
        const triageMetadata = await store.getRunnerFailureTriageMetadata(projectId, repoPath);
        const fullRecentHistory = await store.listRunnerFailureTriageHistory(projectId, repoPath, MAX_HISTORY_SCAN_LIMIT);
        const filteredHistory = filterHistoryByView(fullRecentHistory, resolvedHistoryView);
        const sortedHistory = sortHistoryByChangedAt(filteredHistory, resolvedSortOrder);
        const recentHistory = sortedHistory.slice(0, limit);
        const lastAcknowledgement = findLastAcknowledgement(recentHistory);
        const lastCooldownChange = findLastCooldownChange(recentHistory);
        const timelineEvents = filterTimelineEventsByLabels(recentHistory.map(toTimelineEvent), resolvedTimelineLabels);

        const timeline = {
          eventCount: timelineEvents.length,
          labels: {
            acknowledged: timelineEvents.filter((event) => event.labels.includes("acknowledged")).length,
            cooldown_set: timelineEvents.filter((event) => event.labels.includes("cooldown_set")).length,
            cleared: timelineEvents.filter((event) => event.labels.includes("cleared")).length,
            note_updated: timelineEvents.filter((event) => event.labels.includes("note_updated")).length,
            metadata_updated: timelineEvents.filter((event) => event.labels.includes("metadata_updated")).length,
          },
          events: timelineEvents,
        };

        logToolEvent({
          level: "info",
          tool: "get_runner_failure_triage_metadata",
          stage: "success",
          traceId,
          message: "Fetched runner failure triage metadata",
          data: {
            projectId,
            repoPath,
            historyCount: recentHistory.length,
            totalHistoryCount: fullRecentHistory.length,
            hasCurrentMetadata: triageMetadata !== null,
            durationMs: Date.now() - startedAt,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  traceId,
                  projectId,
                  repoPath,
                  historyView: resolvedHistoryView,
                  sortOrder: resolvedSortOrder,
                  responseMode: resolvedResponseMode,
                  timelineLabels: resolvedTimelineLabels,
                  triageMetadata,
                  historyCount: recentHistory.length,
                  totalHistoryCount: fullRecentHistory.length,
                  lastAcknowledgement,
                  lastCooldownChange,
                  recentHistory,
                  ...(resolvedResponseMode === "timeline" ? { timeline } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "get_runner_failure_triage_metadata",
          stage: "failure",
          traceId,
          message: "Failed to fetch runner failure triage metadata",
          data: {
            projectId,
            repoPath,
            error: error instanceof Error ? error.message : String(error),
            durationMs: Date.now() - startedAt,
          },
        });

        throwAsMcpToolError({
          tool: "get_runner_failure_triage_metadata",
          traceId,
          error,
          defaultCode: "GET_RUNNER_FAILURE_TRIAGE_METADATA_FAILED",
        });
      }
    },
  );
}