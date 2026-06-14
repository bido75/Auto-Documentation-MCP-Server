import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { renderManualMarkdown } from "../lib/export.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { createNotionClient } from "../lib/notion-client.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { getStateStore } from "../lib/state-store.js";
import type { Audience, DocumentationStatus } from "../types.js";

type AudienceFilter = "user" | "admin" | "both";
type PropertyMap = Record<string, unknown>;
type RichTextPart = { plain_text?: string };
type NotionPage = { id: string; properties?: PropertyMap };
type QueryInput = { database_id: string; filter?: unknown; page_size?: number; start_cursor?: string };
type QueryResponse = { results: NotionPage[]; has_more?: boolean; next_cursor?: string | null };
type BlockResponse = { results: Array<{ type?: string; paragraph?: { rich_text?: RichTextPart[] } }> };
type NotionClientLike = {
    databases: { query(input: QueryInput): Promise<QueryResponse> };
    blocks: { children: { list(input: { block_id: string; page_size: number }): Promise<BlockResponse> } };
};
type PublishedEntry = {
    title: string;
    entryType: string;
    audience: Audience;
    status: DocumentationStatus;
    body: string;
};
type LoadPublishedEntriesInput = {
    notion: NotionClientLike;
    manualEntriesDatabaseId: string;
    projectPageId: string;
    releasePageId?: string;
};
type ResolveReleasePageInput = {
    notion: NotionClientLike;
    releasesDatabaseId: string;
    projectPageId: string;
    releaseVersion?: string;
};
type SyncManualToLocalDocsInput = {
    projectId: string;
    audience?: AudienceFilter;
    outputPath?: string;
    releaseVersion?: string;
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
async function loadPublishedEntries(input: LoadPublishedEntriesInput): Promise<PublishedEntry[]> {
    const filters: unknown[] = [
        {
            property: "Project",
            relation: { contains: input.projectPageId },
        },
        {
            property: "Status",
            status: { equals: "Published" },
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
    const entries: PublishedEntry[] = [];
    for (const page of pages) {
        const properties = page.properties ?? {};
        entries.push({
            title: getTitleValue(properties, "Entry Title") ?? `Entry ${page.id}`,
            entryType: getSelectName(properties, "Entry Type") ?? "",
            audience: normalizeAudience(getSelectName(properties, "Audience")),
            status: normalizeStatus(getStatusName(properties, "Status")),
            body: await loadEntryBody(input.notion, page.id),
        });
    }
    return entries;
}
async function resolveReleasePageId(input: ResolveReleasePageInput): Promise<string | undefined> {
    if (!input.releaseVersion) {
        return undefined;
    }
    const releases = await queryAll(input.notion, {
        database_id: input.releasesDatabaseId,
        filter: {
            and: [
                {
                    property: "Project",
                    relation: { contains: input.projectPageId },
                },
                {
                    property: "Release Version",
                    title: { equals: input.releaseVersion },
                },
            ],
        },
        page_size: 10,
    });
    return releases[0]?.id;
}
export function registerSyncManualToLocalDocsTool(server: McpServer): void {
    server.tool("sync_manual_to_local_docs", "Pulls published manual content from Notion and writes it to a local markdown file.", {
        projectId: z.string(),
        audience: z.enum(["user", "admin", "both"]).default("both"),
        outputPath: z.string().default("docs/MANUAL.md"),
        releaseVersion: z.string().optional(),
        traceId: z.string().optional(),
    }, async ({ projectId, audience = "both", outputPath = "docs/MANUAL.md", releaseVersion, traceId: incomingTraceId }: SyncManualToLocalDocsInput) => {
        const traceId = resolveTraceId(incomingTraceId);
        const startedAt = Date.now();
        logToolEvent({
            level: "info",
            tool: "sync_manual_to_local_docs",
            stage: "start",
            traceId,
            message: "Syncing manual content to local docs",
            data: { projectId, audience, outputPath, releaseVersion: releaseVersion ?? null },
        });
        try {
            const store = getStateStore();
            const project = await store.getProject(projectId);
            if (!project) {
                throw new Error("Unknown projectId. Run initialize_project_manual first.");
            }
            const rawNotion = createNotionClient();
            await runProjectPreflight({ notion: rawNotion, project });
            const notion = rawNotion as unknown as NotionClientLike;
            const projectPageId = project.projectPageId ?? project.projectId;
            const releasePageId = await resolveReleasePageId({
                notion,
                releasesDatabaseId: project.databases.releasesDatabaseId,
                projectPageId,
                releaseVersion,
            });
            const entries = await loadPublishedEntries({
                notion,
                manualEntriesDatabaseId: project.databases.manualEntriesDatabaseId,
                projectPageId,
                releasePageId,
            });
            const markdown = renderManualMarkdown({
                projectName: project.projectName,
                audience,
                entries,
            });
            await mkdir(dirname(outputPath), { recursive: true });
            await writeFile(outputPath, markdown, "utf-8");
            logToolEvent({
                level: "info",
                tool: "sync_manual_to_local_docs",
                stage: "success",
                traceId,
                message: "Synced manual content to local docs",
                data: {
                    projectId,
                    outputPath,
                    entryCount: entries.length,
                    byteLength: Buffer.byteLength(markdown, "utf-8"),
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
                            releaseVersion: releaseVersion ?? null,
                            audience,
                            outputPath,
                            entryCount: entries.length,
                            byteLength: Buffer.byteLength(markdown, "utf-8"),
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logToolEvent({
                level: "error",
                tool: "sync_manual_to_local_docs",
                stage: "failure",
                traceId,
                message: "Failed to sync manual content to local docs",
                data: { projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
            });
            throwAsMcpToolError({
                tool: "sync_manual_to_local_docs",
                traceId,
                error,
                defaultCode: "SYNC_MANUAL_TO_LOCAL_DOCS_FAILED",
            });
        }
    });
}
