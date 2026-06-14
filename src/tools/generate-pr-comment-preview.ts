import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createNotionClient } from "../lib/notion-client.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { getStateStore } from "../lib/state-store.js";

type AudienceFilter = "user" | "admin" | "both";
type PropertyMap = Record<string, unknown>;
type NotionPage = { id: string; properties?: PropertyMap };
type QueryInput = { database_id: string; filter?: unknown; page_size?: number; start_cursor?: string };
type QueryResponse = { results: NotionPage[]; has_more?: boolean; next_cursor?: string | null };
type NotionClientLike = { databases: { query(input: QueryInput): Promise<QueryResponse> } };
type PreviewEntry = {
    pageId: string;
    title: string;
    entryType: string;
    audience: string;
    status: string;
    confidenceScore: number | null;
    sourcePr: string | null;
};
type PreviewStatusCounts = Record<string, number>;
type RenderPreviewInput = {
    projectName: string;
    projectId: string;
    prUrl: string | null;
    entryCount: number;
    statusCounts: PreviewStatusCounts;
    entries: PreviewEntry[];
};
type GeneratePrCommentPreviewInput = {
    projectId: string;
    prUrl?: string;
    audience?: AudienceFilter;
    maxEntries?: number;
    traceId?: string;
};

function getTitleValue(properties: PropertyMap, key: string): string | null {
    const value = properties[key];
    return typeof value === "object" && value !== null
        ? ((value as { title?: Array<{ text?: { content?: string } }> }).title?.[0]?.text?.content ?? null)
        : null;
}
function getSelectName(properties: PropertyMap, key: string): string | null {
    const value = properties[key];
    return typeof value === "object" && value !== null ? ((value as { select?: { name?: string } }).select?.name ?? null) : null;
}
function getStatusName(properties: PropertyMap, key: string): string | null {
    const value = properties[key];
    return typeof value === "object" && value !== null ? ((value as { status?: { name?: string } }).status?.name ?? null) : null;
}
function getNumberValue(properties: PropertyMap, key: string): number | null {
    const value = properties[key];
    return typeof value === "object" && value !== null && typeof (value as { number?: unknown }).number === "number"
        ? (value as { number: number }).number
        : null;
}
function getUrlValue(properties: PropertyMap, key: string): string | null {
    const value = properties[key];
    return typeof value === "object" && value !== null && typeof (value as { url?: unknown }).url === "string"
        ? (value as { url: string }).url
        : null;
}
function matchesAudience(audience: string, filter: AudienceFilter = "both"): boolean {
    if (filter === "both") {
        return true;
    }
    if (filter === "user") {
        return audience === "User" || audience === "Both";
    }
    return audience === "Admin" || audience === "Both";
}
function statusRank(status: string): number {
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
async function queryAll(notion: NotionClientLike, input: QueryInput): Promise<NotionPage[]> {
    const results: NotionPage[] = [];
    let cursor: string | undefined;
    do {
        const payload: QueryInput = {
            ...input,
            ...(cursor ? { start_cursor: cursor } : {}),
        };
        const response = await withNotionRetry(() => notion.databases.query(payload), {
            operationName: "databases.query",
            payload,
        });
        results.push(...response.results);
        cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return results;
}
function renderPreviewMarkdown(input: RenderPreviewInput): string {
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
export function registerGeneratePrCommentPreviewTool(server: McpServer): void {
    server.tool("generate_pr_comment_preview", "Builds a markdown preview payload suitable for a GitHub PR comment.", {
        projectId: z.string(),
        prUrl: z.string().url().optional(),
        audience: z.enum(["user", "admin", "both"]).default("both"),
        maxEntries: z.number().int().min(1).max(50).default(8),
        traceId: z.string().optional(),
    }, async (input: GeneratePrCommentPreviewInput) => {
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
            const rawNotion = createNotionClient();
            await runProjectPreflight({ notion: rawNotion, project });
            const notion = rawNotion as unknown as NotionClientLike;
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
            const statusCounts = selectedEntries.reduce<PreviewStatusCounts>((acc, entry) => {
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
