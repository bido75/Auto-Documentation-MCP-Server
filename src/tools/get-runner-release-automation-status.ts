// @ts-nocheck
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { getStateStore } from "../lib/state-store.js";
export function registerGetRunnerReleaseAutomationStatusTool(server) {
    server.tool("get_runner_release_automation_status", "Reports persisted runner release automation status for a project and repository target.", {
        projectId: z.string().min(1),
        repoPath: z.string().min(1),
        releaseTag: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).default(10),
        traceId: z.string().optional(),
    }, async ({ projectId, repoPath, releaseTag, limit, traceId: incomingTraceId }) => {
        const traceId = resolveTraceId(incomingTraceId);
        const startedAt = Date.now();
        logToolEvent({
            level: "info",
            tool: "get_runner_release_automation_status",
            stage: "start",
            traceId,
            message: "Fetching runner release automation status",
            data: {
                projectId,
                repoPath,
                releaseTag: releaseTag ?? null,
                limit,
            },
        });
        try {
            const store = getStateStore();
            const lastSeenReleaseTag = await store.getLastSeenReleaseTag(projectId, repoPath);
            const queriedRun = releaseTag ? await store.getReleaseAutomationRun(projectId, repoPath, releaseTag) : null;
            const recentRuns = (await store.listReleaseAutomationRuns(projectId, repoPath)).slice(0, limit);
            const lastSuccessfulRun = recentRuns.find((run) => run.status === "success") ?? null;
            const lastFailedRun = recentRuns.find((run) => run.status === "failure") ?? null;
            logToolEvent({
                level: "info",
                tool: "get_runner_release_automation_status",
                stage: "success",
                traceId,
                message: "Fetched runner release automation status",
                data: {
                    projectId,
                    repoPath,
                    lastSeenReleaseTag,
                    recentRunCount: recentRuns.length,
                    durationMs: Date.now() - startedAt,
                },
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            traceId,
                            projectId,
                            repoPath,
                            releaseTag: releaseTag ?? null,
                            lastSeenReleaseTag,
                            recentRunCount: recentRuns.length,
                            queriedRun,
                            lastSuccessfulRun,
                            lastFailedRun,
                            recentRuns,
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logToolEvent({
                level: "error",
                tool: "get_runner_release_automation_status",
                stage: "failure",
                traceId,
                message: "Failed to fetch runner release automation status",
                data: {
                    projectId,
                    repoPath,
                    releaseTag: releaseTag ?? null,
                    error: error instanceof Error ? error.message : String(error),
                    durationMs: Date.now() - startedAt,
                },
            });
            throwAsMcpToolError({
                tool: "get_runner_release_automation_status",
                traceId,
                error,
                defaultCode: "GET_RUNNER_RELEASE_AUTOMATION_STATUS_FAILED",
            });
        }
    });
}
