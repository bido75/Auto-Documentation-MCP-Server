// @ts-nocheck
import { z } from "zod";
import { createNotionClient } from "../lib/notion-client.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { getStateStore } from "../lib/state-store.js";
function getTitleValue(properties, key) {
    const value = properties[key];
    return value?.title?.[0]?.text?.content ?? null;
}
function getSelectName(properties, key) {
    const value = properties[key];
    return value?.select?.name ?? null;
}
function getStatusName(properties, key) {
    const value = properties[key];
    return value?.status?.name ?? null;
}
function getNumberValue(properties, key) {
    const value = properties[key];
    return typeof value?.number === "number" ? value.number : null;
}
function getUrlValue(properties, key) {
    const value = properties[key];
    return typeof value?.url === "string" ? value.url : null;
}
function matchesAudience(audience, filter) {
    if (filter === "both") {
        return true;
    }
    if (filter === "user") {
        return audience === "User" || audience === "Both";
    }
    return audience === "Admin" || audience === "Both";
}
function statusRank(status) {
    if (status === "Published") {
        return 0;
    }
    if (status === "Approved") {
        return 1;
    }
    if (status === "Needs Review") {
        return 2;
    }
    if (status === "Captured") {
        return 3;
    }
    return 9;
}
async function queryAll(notion, input) {
    const results = [];
    let cursor;
    do {
        const payload = {
            ...input,
            ...(cursor ? { start_cursor: cursor } : {}),
        };
        const response = (await withNotionRetry(() => notion.databases.query(payload), {
            operationName: "databases.query",
            payload,
        }));
        results.push(...response.results);
        cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return results;
}
function renderPreviewMarkdown(input) {
    const summaryLine = [
        `Published: ${input.statusCounts.Published ?? 0}`,
        `Approved: ${input.statusCounts.Approved ?? 0}`,
        `Needs Review: ${input.statusCounts["Needs Review"] ?? 0}`,
        `Captured: ${input.statusCounts.Captured ?? 0}`,
    ].join(" | ");
    if (input.entryCount === 0) {
        return [
            "### Auto-Documentation Preview",
            "",
            `Project: **${input.projectName}** (${input.projectId})`,
            ...(input.prUrl ? [`PR: ${input.prUrl}`] : []),
            "",
            "No matching manual entries were found for this preview window.",
        ].join("\n");
    }
    return [
        "### Auto-Documentation Preview",
        "",
        `Project: **${input.projectName}** (${input.projectId})`,
        ...(input.prUrl ? [`PR: ${input.prUrl}`] : []),
        `Entries: **${input.entryCount}**`,
        summaryLine,
        "",
        ...input.entries.map((entry) => {
            const confidence = entry.confidenceScore === null ? "n/a" : String(entry.confidenceScore);
            return `- **${entry.title}** (${entry.entryType}) - ${entry.status} | Audience: ${entry.audience} | Confidence: ${confidence}`;
        }),
    ].join("\n");
}
export function registerGeneratePrCommentPreviewTool(server) {
    server.tool("generate_pr_comment_preview", "Builds a markdown preview payload suitable for a GitHub PR comment.", {
        projectId: z.string(),
        prUrl: z.string().url().optional(),
        audience: z.enum(["user", "admin", "both"]).default("both"),
        maxEntries: z.number().int().min(1).max(50).default(8),
        traceId: z.string().optional(),
    }, async (input) => {
        const traceId = resolveTraceId(input.traceId);
        const startedAt = Date.now();
        logToolEvent({
            level: "info",
            tool: "generate_pr_comment_preview",
            stage: "start",
            traceId,
            message: "Generating PR comment preview",
            data: { projectId: input.projectId, prUrl: input.prUrl ?? null, audience: input.audience },
        });
        try {
            const store = getStateStore();
            const project = await store.getProject(input.projectId);
            if (!project) {
                throw new Error("Unknown projectId. Run initialize_project_manual first.");
            }
            const notion = createNotionClient();
            await runProjectPreflight({ notion, project });
            const records = await queryAll(notion, {
                database_id: project.databases.manualEntriesDatabaseId,
                filter: {
                    and: [
                        {
                            property: "Project",
                            relation: { contains: project.projectPageId ?? project.projectId },
                        },
                    ],
                },
                page_size: 100,
            });
            const previewEntries = records
                .map((record) => {
                const properties = record.properties ?? {};
                return {
                    pageId: record.id,
                    title: getTitleValue(properties, "Entry Title") ?? `Entry ${record.id}`,
                    entryType: getSelectName(properties, "Entry Type") ?? "Unknown",
                    audience: (getSelectName(properties, "Audience") ?? "Internal"),
                    status: getStatusName(properties, "Status") ?? "Captured",
                    confidenceScore: getNumberValue(properties, "Confidence Score"),
                    sourcePr: getUrlValue(properties, "Source PR"),
                };
            })
                .filter((entry) => matchesAudience(entry.audience, input.audience))
                .filter((entry) => !input.prUrl || entry.sourcePr === input.prUrl)
                .sort((a, b) => {
                const byStatus = statusRank(a.status) - statusRank(b.status);
                if (byStatus !== 0) {
                    return byStatus;
                }
                return a.title.localeCompare(b.title);
            });
            const selectedEntries = previewEntries.slice(0, input.maxEntries);
            const statusCounts = selectedEntries.reduce((acc, entry) => {
                acc[entry.status] = (acc[entry.status] ?? 0) + 1;
                return acc;
            }, {});
            const markdownPreview = renderPreviewMarkdown({
                projectName: project.projectName,
                projectId: input.projectId,
                prUrl: input.prUrl ?? null,
                entryCount: selectedEntries.length,
                statusCounts,
                entries: selectedEntries,
            });
            logToolEvent({
                level: "info",
                tool: "generate_pr_comment_preview",
                stage: "success",
                traceId,
                message: "Generated PR comment preview",
                data: { projectId: input.projectId, entryCount: selectedEntries.length, durationMs: Date.now() - startedAt },
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            traceId,
                            projectId: input.projectId,
                            prUrl: input.prUrl ?? null,
                            entryCount: selectedEntries.length,
                            statusCounts,
                            markdownPreview,
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logToolEvent({
                level: "error",
                tool: "generate_pr_comment_preview",
                stage: "failure",
                traceId,
                message: "Failed to generate PR comment preview",
                data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
            });
            throwAsMcpToolError({
                tool: "generate_pr_comment_preview",
                traceId,
                error,
                defaultCode: "GENERATE_PR_COMMENT_PREVIEW_FAILED",
            });
        }
    });
}
