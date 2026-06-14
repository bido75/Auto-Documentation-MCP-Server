import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createNotionClient } from "../lib/notion-client.js";
import { resolveArtifactPath } from "../lib/artifact-paths.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { generatePdfFromMarkdown } from "../lib/pdf.js";
import { getStateStore } from "../lib/state-store.js";
import { buildMarkdownManual } from "../packaging/manual-packager.js";
import type { Audience, DocumentationStatus } from "../types.js";

type AudienceFilter = "user" | "admin" | "both";
type PropertyMap = Record<string, unknown>;
type RichTextPart = { plain_text?: string };
type NotionPage = { id: string; properties?: PropertyMap };
type QueryInput = { database_id: string; filter?: unknown; page_size?: number; start_cursor?: string };
type QueryResponse = { results: NotionPage[]; has_more?: boolean; next_cursor?: string | null };
type BlockResponse = {
    results: Array<{ type?: string; paragraph?: { rich_text?: RichTextPart[] } }>;
};
type NotionClientLike = {
    databases: { query(input: QueryInput): Promise<QueryResponse> };
    blocks: { children: { list(input: { block_id: string; page_size: number }): Promise<BlockResponse> } };
};
type ManualEntry = {
    pageId: string;
    title: string;
    audience: Audience;
    status: DocumentationStatus;
    body: string;
};
type LoadProjectEntriesInput = {
    notion: NotionClientLike;
    manualEntriesDatabaseId: string;
    projectPageId: string;
    releasePageId?: string;
};
type ExportManualPdfInput = {
    projectId: string;
    releaseVersion: string;
    audience?: AudienceFilter;
    outputPath: string;
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
function normalizeAudience(value: string | null): Audience {
    return value === "User" || value === "Admin" || value === "Both" || value === "Internal" ? value : "Internal";
}
function normalizeStatus(value: string | null): DocumentationStatus {
    return value === "Captured" || value === "Needs Review" || value === "Approved" || value === "Published" ? value : "Captured";
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
async function loadEntryBody(notion: NotionClientLike, pageId: string): Promise<string> {
    const response = await withNotionRetry(() => notion.blocks.children.list({
        block_id: pageId,
        page_size: 100,
    }), {
        operationName: "blocks.children.list",
        payload: {
            block_id: pageId,
            page_size: 100,
        },
    });
    const lines: string[] = [];
    for (const block of response.results) {
        if (block.type !== "paragraph") {
            continue;
        }
        const text = (block.paragraph?.rich_text ?? []).map((part: RichTextPart) => part.plain_text ?? "").join("").trim();
        if (text) {
            lines.push(text);
        }
    }
    return lines.join("\n");
}
function isIncluded(entry: ManualEntry, audience: AudienceFilter): boolean {
    const isPublishable = entry.status === "Published" || entry.status === "Approved";
    if (!isPublishable) {
        return false;
    }
    if (audience === "both") {
        return entry.audience === "User" || entry.audience === "Admin" || entry.audience === "Both";
    }
    if (audience === "user") {
        return entry.audience === "User" || entry.audience === "Both";
    }
    return entry.audience === "Admin" || entry.audience === "Both";
}
async function loadProjectEntries(input: LoadProjectEntriesInput): Promise<ManualEntry[]> {
    const filters: unknown[] = [
        {
            property: "Project",
            relation: { contains: input.projectPageId },
        },
    ];
    if (input.releasePageId) {
        filters.push({
            property: "Release",
            relation: { contains: input.releasePageId },
        });
    }
    const pages = await queryAll(input.notion, {
        database_id: input.manualEntriesDatabaseId,
        filter: { and: filters },
        page_size: 100,
    });
    const entries: ManualEntry[] = [];
    for (const page of pages) {
        const properties = page.properties ?? {};
        entries.push({
            pageId: page.id,
            title: getTitleValue(properties, "Entry Title") ?? `Entry ${page.id}`,
            audience: normalizeAudience(getSelectName(properties, "Audience")),
            status: normalizeStatus(getStatusName(properties, "Status")),
            body: await loadEntryBody(input.notion, page.id),
        });
    }
    return entries;
}
export function registerExportManualPdfTool(server: McpServer): void {
    server.tool("export_manual_pdf", "Exports a release-ready manual as a local PDF artifact.", {
        projectId: z.string(),
        releaseVersion: z.string(),
        audience: z.enum(["user", "admin", "both"]).default("both"),
        outputPath: z.string(),
        traceId: z.string().optional(),
    }, async ({ projectId, releaseVersion, audience = "both", outputPath, traceId: incomingTraceId }: ExportManualPdfInput) => {
        const traceId = resolveTraceId(incomingTraceId);
        const startedAt = Date.now();
        logToolEvent({
            level: "info",
            tool: "export_manual_pdf",
            stage: "start",
            traceId,
            message: "Exporting manual PDF",
            data: { projectId, releaseVersion, audience, outputPath },
        });
        try {
            const safeOutputPath = resolveArtifactPath(outputPath);
            const store = getStateStore();
            const project = await store.getProject(projectId);
            if (!project) {
                throw new Error("Unknown projectId. Run initialize_project_manual first.");
            }
            const rawNotion = createNotionClient();
            await runProjectPreflight({ notion: rawNotion, project });
            const notion = rawNotion as unknown as NotionClientLike;
            const projectPageId = project.projectPageId ?? project.projectId;
            const releasePages = await queryAll(notion, {
                database_id: project.databases.releasesDatabaseId,
                filter: {
                    and: [
                        {
                            property: "Project",
                            relation: { contains: projectPageId },
                        },
                        {
                            property: "Release Version",
                            title: { equals: releaseVersion },
                        },
                    ],
                },
                page_size: 10,
            });
            const releasePageId = releasePages[0]?.id;
            const sourceEntries = await loadProjectEntries({
                notion,
                manualEntriesDatabaseId: project.databases.manualEntriesDatabaseId,
                projectPageId,
                releasePageId,
            });
            const selectedAudience = audience === "both" ? "Both" : audience === "user" ? "User" : "Admin";
            const markdown = buildMarkdownManual({
                projectName: project.projectName,
                releaseVersion,
                audience: selectedAudience,
                entries: sourceEntries,
            });
            const includedEntryCount = sourceEntries.filter((entry) => isIncluded(entry, audience)).length;
            const excludedEntryCount = sourceEntries.length - includedEntryCount;
            const pdfPath = await generatePdfFromMarkdown({
                title: `${project.projectName} ${releaseVersion} Manual`,
                markdown,
                outputPath: safeOutputPath,
            });
            logToolEvent({
                level: "info",
                tool: "export_manual_pdf",
                stage: "success",
                traceId,
                message: "Exported manual PDF",
                data: {
                    projectId,
                    releaseVersion,
                    includedEntryCount,
                    excludedEntryCount,
                    outputPath: pdfPath,
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
                            releaseVersion,
                            audience,
                            includedEntryCount,
                            excludedEntryCount,
                            outputPath: pdfPath,
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logToolEvent({
                level: "error",
                tool: "export_manual_pdf",
                stage: "failure",
                traceId,
                message: "Failed to export manual PDF",
                data: { projectId, releaseVersion, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
            });
            throwAsMcpToolError({
                tool: "export_manual_pdf",
                traceId,
                error,
                defaultCode: "EXPORT_MANUAL_PDF_FAILED",
            });
        }
    });
}
