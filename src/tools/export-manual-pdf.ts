// @ts-nocheck
import { z } from "zod";
import { createNotionClient } from "../lib/notion-client.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { generatePdfFromMarkdown } from "../lib/pdf.js";
import { getStateStore } from "../lib/state-store.js";
import { buildMarkdownManual } from "../packaging/manual-packager.js";
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
function isIncluded(entry, audience) {
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
async function loadProjectEntries(input) {
    const filters = [
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
    const entries = [];
    for (const page of pages) {
        const properties = page.properties ?? {};
        entries.push({
            pageId: page.id,
            title: getTitleValue(properties, "Entry Title") ?? `Entry ${page.id}`,
            audience: (getSelectName(properties, "Audience") ?? "Internal"),
            status: (getStatusName(properties, "Status") ?? "Captured"),
            body: await loadEntryBody(input.notion, page.id),
        });
    }
    return entries;
}
export function registerExportManualPdfTool(server) {
    server.tool("export_manual_pdf", "Exports a release-ready manual as a local PDF artifact.", {
        projectId: z.string(),
        releaseVersion: z.string(),
        audience: z.enum(["user", "admin", "both"]).default("both"),
        outputPath: z.string(),
        traceId: z.string().optional(),
    }, async ({ projectId, releaseVersion, audience, outputPath, traceId: incomingTraceId }) => {
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
            const store = getStateStore();
            const project = await store.getProject(projectId);
            if (!project) {
                throw new Error("Unknown projectId. Run initialize_project_manual first.");
            }
            const notion = createNotionClient();
            await runProjectPreflight({ notion, project });
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
                outputPath,
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
