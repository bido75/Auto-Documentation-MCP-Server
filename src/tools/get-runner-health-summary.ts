// @ts-nocheck
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { getStateStore } from "../lib/state-store.js";
import { parseContinuousRunnerTargets } from "../runner/index.js";
function calculateFailureStreak(runs) {
    let streak = 0;
    for (const run of runs) {
        if (run.status !== "failure") {
            break;
        }
        streak += 1;
    }
    return streak;
}
function calculateRecencyPoints(attemptedAt, nowMs) {
    const attemptedMs = Date.parse(attemptedAt);
    if (!Number.isFinite(attemptedMs)) {
        return 0;
    }
    const ageMinutes = (nowMs - attemptedMs) / 60_000;
    if (ageMinutes <= 15) {
        return 20;
    }
    if (ageMinutes <= 60) {
        return 15;
    }
    if (ageMinutes <= 360) {
        return 10;
    }
    if (ageMinutes <= 1_440) {
        return 5;
    }
    return 0;
}
function toDateMs(value) {
    if (!value) {
        return null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function minutesSince(attemptedAt, nowMs) {
    const attemptedMs = toDateMs(attemptedAt);
    if (attemptedMs === null) {
        return null;
    }
    return Math.max(0, Math.round((nowMs - attemptedMs) / 60_000));
}
function findLastSuccessAt(runs) {
    const successRun = runs.find((run) => run.status === "success");
    return successRun?.attemptedAt ?? null;
}
function isStaleFailure(minutesSinceFailure, thresholdMinutes) {
    return minutesSinceFailure !== null && minutesSinceFailure >= thresholdMinutes;
}
function requiresEscalation(input) {
    if (input.failureStreak >= input.escalationFailureStreakThreshold) {
        return true;
    }
    if (input.severity === "critical") {
        return true;
    }
    return input.stale && input.severity === "high";
}
function isCooldownActive(cooldownUntil, nowMs) {
    if (!cooldownUntil) {
        return false;
    }
    const cooldownUntilMs = toDateMs(cooldownUntil);
    return cooldownUntilMs !== null && cooldownUntilMs > nowMs;
}
function calculatePriorityScore(input) {
    let score = input.severityScore;
    if (input.escalated) {
        score += 20;
    }
    if (input.stale) {
        score += 10;
    }
    if (input.acknowledged) {
        score -= 15;
    }
    if (input.cooldownActive) {
        score -= 35;
    }
    return Math.max(0, Math.min(score, 150));
}
function sortHighestPriorityTargets(a, b) {
    if (a.escalated !== b.escalated) {
        return Number(b.escalated) - Number(a.escalated);
    }
    if (a.priorityScore !== b.priorityScore) {
        return b.priorityScore - a.priorityScore;
    }
    return sortFailureTargets(a, b);
}
function calculateFailureSeverityScore(input, nowMs) {
    const baseScore = 50;
    const streakPoints = Math.min(input.failureStreak * 10, 30);
    const recencyPoints = calculateRecencyPoints(input.attemptedAt, nowMs);
    return Math.min(baseScore + streakPoints + recencyPoints, 100);
}
function toFailureSeverity(score) {
    if (score >= 85) {
        return "critical";
    }
    if (score >= 70) {
        return "high";
    }
    if (score >= 55) {
        return "medium";
    }
    return "low";
}
function sortFailureTargets(a, b) {
    const aTime = a.attemptedAt ? Date.parse(a.attemptedAt) : Number.NEGATIVE_INFINITY;
    const bTime = b.attemptedAt ? Date.parse(b.attemptedAt) : Number.NEGATIVE_INFINITY;
    if (aTime !== bTime) {
        return bTime - aTime;
    }
    return b.failureStreak - a.failureStreak;
}
function resolveTargetStatus(input) {
    if (!input.releaseAutomation) {
        return "disabled";
    }
    if (!input.latestRun && !input.lastSeenReleaseTag) {
        return "no_data";
    }
    if (input.latestRun?.status === "failure") {
        return "failing";
    }
    if (input.latestRun?.status === "success") {
        return "healthy";
    }
    if (input.lastSeenReleaseTag) {
        return "healthy";
    }
    return "pending";
}
function normalizeTargets(inputTargets) {
    if (inputTargets && inputTargets.length > 0) {
        return {
            source: "input",
            targets: inputTargets,
        };
    }
    const parsed = parseContinuousRunnerTargets(process.env);
    return {
        source: "env",
        targets: parsed.map((target) => ({
            projectId: target.projectId,
            repoPath: target.repoPath,
            releaseAutomation: target.releaseAutomation,
        })),
    };
}
export function registerGetRunnerHealthSummaryTool(server) {
    server.tool("get_runner_health_summary", "Aggregates compact runner release automation health across configured targets.", {
        targets: z
            .array(z.object({
            projectId: z.string().min(1),
            repoPath: z.string().min(1),
            releaseAutomation: z.boolean().optional(),
        }))
            .optional(),
        limitPerTarget: z.number().int().min(1).max(20).default(1),
        includeTargets: z.boolean().default(true),
        highestPriorityLimit: z.number().int().min(1).max(20).default(3),
        staleFailureMinutesThreshold: z.number().int().min(1).max(10080).default(120),
        escalationFailureStreakThreshold: z.number().int().min(1).max(20).default(3),
        traceId: z.string().optional(),
    }, async ({ targets: inputTargets, limitPerTarget, includeTargets, highestPriorityLimit, staleFailureMinutesThreshold, escalationFailureStreakThreshold, traceId: incomingTraceId, }) => {
        const traceId = resolveTraceId(incomingTraceId);
        const startedAt = Date.now();
        const resolvedLimitPerTarget = limitPerTarget ?? 1;
        const resolvedIncludeTargets = includeTargets ?? true;
        const resolvedHighestPriorityLimit = highestPriorityLimit ?? 3;
        const resolvedStaleFailureMinutesThreshold = staleFailureMinutesThreshold ?? 120;
        const resolvedEscalationFailureStreakThreshold = escalationFailureStreakThreshold ?? 3;
        logToolEvent({
            level: "info",
            tool: "get_runner_health_summary",
            stage: "start",
            traceId,
            message: "Computing runner health summary",
            data: {
                inputTargetCount: inputTargets?.length ?? 0,
                limitPerTarget: resolvedLimitPerTarget,
                highestPriorityLimit: resolvedHighestPriorityLimit,
                staleFailureMinutesThreshold: resolvedStaleFailureMinutesThreshold,
                escalationFailureStreakThreshold: resolvedEscalationFailureStreakThreshold,
            },
        });
        try {
            const store = getStateStore();
            const { source, targets } = normalizeTargets(inputTargets);
            const uniqueTargets = new Map();
            for (const target of targets) {
                const key = `${target.projectId}::${target.repoPath}`;
                uniqueTargets.set(key, target);
            }
            const summaries = [];
            const nowMs = Date.now();
            for (const target of uniqueTargets.values()) {
                const releaseAutomation = target.releaseAutomation ?? true;
                const lastSeenReleaseTag = await store.getLastSeenReleaseTag(target.projectId, target.repoPath);
                const allRuns = await store.listReleaseAutomationRuns(target.projectId, target.repoPath);
                const latestRun = allRuns[0] ?? null;
                const failureStreak = calculateFailureStreak(allRuns);
                const lastSuccessAt = findLastSuccessAt(allRuns);
                const triageMetadata = await store.getRunnerFailureTriageMetadata(target.projectId, target.repoPath);
                summaries.push({
                    projectId: target.projectId,
                    repoPath: target.repoPath,
                    releaseAutomation,
                    status: resolveTargetStatus({
                        releaseAutomation,
                        lastSeenReleaseTag,
                        latestRun,
                    }),
                    lastSeenReleaseTag,
                    failureStreak,
                    lastSuccessAt,
                    triageMetadata,
                    latestRun: latestRun
                        ? {
                            releaseTag: latestRun.releaseTag,
                            releaseVersion: latestRun.releaseVersion,
                            status: latestRun.status,
                            attemptedAt: latestRun.attemptedAt,
                            ...(latestRun.errorMessage ? { errorMessage: latestRun.errorMessage } : {}),
                        }
                        : null,
                });
            }
            const counts = {
                healthy: summaries.filter((item) => item.status === "healthy").length,
                failing: summaries.filter((item) => item.status === "failing").length,
                pending: summaries.filter((item) => item.status === "pending").length,
                disabled: summaries.filter((item) => item.status === "disabled").length,
                noData: summaries.filter((item) => item.status === "no_data").length,
            };
            const failingTargets = summaries
                .filter((item) => item.status === "failing")
                .map((item) => {
                const attemptedAt = item.latestRun?.attemptedAt ?? null;
                const minutesSinceFailureValue = minutesSince(attemptedAt, nowMs);
                const severityScore = attemptedAt === null
                    ? 50
                    : calculateFailureSeverityScore({
                        failureStreak: item.failureStreak,
                        attemptedAt,
                    }, nowMs);
                const severity = toFailureSeverity(severityScore);
                const stale = isStaleFailure(minutesSinceFailureValue, resolvedStaleFailureMinutesThreshold);
                const escalated = requiresEscalation({
                    failureStreak: item.failureStreak,
                    severity,
                    stale,
                    escalationFailureStreakThreshold: resolvedEscalationFailureStreakThreshold,
                });
                const acknowledged = item.triageMetadata?.acknowledgedAt !== undefined;
                const cooldownActive = isCooldownActive(item.triageMetadata?.cooldownUntil, nowMs);
                const priorityScore = calculatePriorityScore({
                    severityScore,
                    escalated,
                    stale,
                    acknowledged,
                    cooldownActive,
                });
                return {
                    projectId: item.projectId,
                    repoPath: item.repoPath,
                    releaseTag: item.latestRun?.releaseTag ?? null,
                    attemptedAt,
                    failureStreak: item.failureStreak,
                    lastSuccessAt: item.lastSuccessAt,
                    minutesSinceFailure: minutesSinceFailureValue,
                    stale,
                    escalated,
                    acknowledged,
                    acknowledgedAt: item.triageMetadata?.acknowledgedAt ?? null,
                    acknowledgedBy: item.triageMetadata?.acknowledgedBy ?? null,
                    cooldownUntil: item.triageMetadata?.cooldownUntil ?? null,
                    cooldownActive,
                    note: item.triageMetadata?.note ?? null,
                    priorityScore,
                    deprioritized: acknowledged || cooldownActive,
                    severityScore,
                    severity,
                    errorMessage: item.latestRun?.errorMessage ?? "Unknown error",
                };
            })
                .sort(sortFailureTargets);
            const highestPriorityTargets = [...failingTargets]
                .sort(sortHighestPriorityTargets)
                .slice(0, resolvedHighestPriorityLimit);
            const triage = {
                criticalCount: failingTargets.filter((target) => target.severity === "critical").length,
                highCount: failingTargets.filter((target) => target.severity === "high").length,
                mediumCount: failingTargets.filter((target) => target.severity === "medium").length,
                lowCount: failingTargets.filter((target) => target.severity === "low").length,
                staleFailureCount: failingTargets.filter((target) => target.stale).length,
                escalationCount: failingTargets.filter((target) => target.escalated).length,
                acknowledgedCount: failingTargets.filter((target) => target.acknowledged).length,
                cooldownActiveCount: failingTargets.filter((target) => target.cooldownActive).length,
                newestFailureAt: failingTargets[0]?.attemptedAt ?? null,
                oldestFailureAt: failingTargets.length > 0 ? failingTargets[failingTargets.length - 1]?.attemptedAt ?? null : null,
                highestPriorityCount: highestPriorityTargets.length,
                highestPriorityLimit: resolvedHighestPriorityLimit,
                staleFailureMinutesThreshold: resolvedStaleFailureMinutesThreshold,
                escalationFailureStreakThreshold: resolvedEscalationFailureStreakThreshold,
            };
            logToolEvent({
                level: "info",
                tool: "get_runner_health_summary",
                stage: "success",
                traceId,
                message: "Computed runner health summary",
                data: {
                    source,
                    targetCount: summaries.length,
                    failingCount: counts.failing,
                    durationMs: Date.now() - startedAt,
                },
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            traceId,
                            source,
                            targetCount: summaries.length,
                            counts,
                            triage,
                            failingTargets,
                            highestPriorityTargets,
                            ...(resolvedIncludeTargets ? { targets: summaries } : {}),
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logToolEvent({
                level: "error",
                tool: "get_runner_health_summary",
                stage: "failure",
                traceId,
                message: "Failed to compute runner health summary",
                data: {
                    error: error instanceof Error ? error.message : String(error),
                    durationMs: Date.now() - startedAt,
                },
            });
            throwAsMcpToolError({
                tool: "get_runner_health_summary",
                traceId,
                error,
                defaultCode: "GET_RUNNER_HEALTH_SUMMARY_FAILED",
            });
        }
    });
}
