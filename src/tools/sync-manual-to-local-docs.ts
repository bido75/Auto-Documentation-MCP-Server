// @ts-nocheck
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { renderManualMarkdown } from "../lib/export.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { createNotionClient } from "../lib/notion-client.js";
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
async function loadEntryBody(notion, pageId) {
    const response = (await withNotionRetry(() => notion.blocks.children.list({
        block_id: pageId,
        page_size: 100,
    }), {
        operationName: "blocks.children.list",
        payload: {
            block_id: pageId,
            page_size: 100,
        },
    }));
    const lines = [];
    for (const block of response.results) {
        if (block.type !== "paragraph") {
            continue;
        }
        const text = (block.paragraph?.rich_text ?? []).map((part) => part.plain_text ?? "").join("").trim();
        if (text) {
            lines.push(text);
        }
    }
    return lines.join("\n");
}
async function loadPublishedEntries(input) {
    const filters = [
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
    const entries = [];
    for (const page of pages) {
        const properties = page.properties ?? {};
        entries.push({
            title: getTitleValue(properties, "Entry Title") ?? `Entry ${page.id}`,
            entryType: getSelectName(properties, "Entry Type") ?? "",
            audience: (getSelectName(properties, "Audience") ?? "Internal"),
            status: (getStatusName(properties, "Status") ?? "Captured"),
            body: await loadEntryBody(input.notion, page.id),
        });
    }
    return entries;
}
async function resolveReleasePageId(input) {
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
export function registerSyncManualToLocalDocsTool(server) {
    server.tool("sync_manual_to_local_docs", "Pulls published manual content from Notion and writes it to a local markdown file.", {
        projectId: z.string(),
        audience: z.enum(["user", "admin", "both"]).default("both"),
        outputPath: z.string().default("docs/MANUAL.md"),
        releaseVersion: z.string().optional(),
        traceId: z.string().optional(),
    }, async ({ projectId, audience, outputPath, releaseVersion, traceId: incomingTraceId }) => {
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
            const notion = createNotionClient();
            await runProjectPreflight({ notion, project });
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
