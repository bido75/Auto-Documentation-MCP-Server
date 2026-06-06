// @ts-nocheck
import { z } from "zod";
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
function getNumberValue(properties, key) {
    const value = properties[key];
    return typeof value?.number === "number" ? value.number : null;
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
async function loadEntryBodySummary(notion, pageId) {
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
    for (const block of response.results) {
        if (block.type !== "paragraph") {
            continue;
        }
        const text = (block.paragraph?.rich_text ?? []).map((part) => part.plain_text ?? "").join(" ").trim();
        if (text.length > 0) {
            return text.length > 220 ? `${text.slice(0, 220)}...` : text;
        }
    }
    return "";
}
function sectionFor(entryType, audience) {
    if (entryType === "Developer Note" || audience === "Internal") {
        return "developer";
    }
    if (entryType === "Admin Guide" || audience === "Admin") {
        return "admin";
    }
    return "user";
}
function formatEntryLine(entry) {
    const score = typeof entry.confidenceScore === "number" ? ` (confidence ${entry.confidenceScore})` : "";
    return entry.body.length > 0 ? `- ${entry.title}${score}: ${entry.body}` : `- ${entry.title}${score}`;
}
function buildChangelogMarkdown(input) {
    const user = [];
    const admin = [];
    const developer = [];
    for (const entry of input.entries) {
        const line = formatEntryLine(entry);
        const section = sectionFor(entry.entryType, entry.audience);
        if (section === "user") {
            user.push(line);
        }
        else if (section === "admin") {
            admin.push(line);
        }
        else {
            developer.push(line);
        }
    }
    const section = (title, lines) => [
        `## ${title}`,
        "",
        ...(lines.length > 0 ? lines : ["- No updates in this section."]),
        "",
    ];
    return [
        `# ${input.projectName} - ${input.releaseVersion} Changelog`,
        "",
        ...section("User Impact", user),
        ...section("Admin / Operations", admin),
        ...section("Developer Notes", developer),
    ].join("\n");
}
export function registerGenerateReleaseChangelogTool(server) {
    server.tool("generate_release_changelog", "Generates a release changelog markdown from approved/published manual entries linked to a release.", {
        projectId: z.string(),
        releaseVersion: z.string().min(1),
        maxEntries: z.number().int().positive().max(200).default(50),
        traceId: z.string().optional(),
    }, async ({ projectId, releaseVersion, maxEntries, traceId: incomingTraceId }) => {
        const traceId = resolveTraceId(incomingTraceId);
        const startedAt = Date.now();
        logToolEvent({
            level: "info",
            tool: "generate_release_changelog",
            stage: "start",
            traceId,
            message: "Generating release changelog",
            data: { projectId, releaseVersion, maxEntries },
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
            const releasePageId = releasePages[0]?.id ?? null;
            const manualFilters = [
                {
                    property: "Project",
                    relation: { contains: projectPageId },
                },
                {
                    or: [
                        {
                            property: "Status",
                            status: { equals: "Published" },
                        },
                        {
                            property: "Status",
                            status: { equals: "Approved" },
                        },
                    ],
                },
            ];
            if (releasePageId) {
                manualFilters.push({
                    property: "Release",
                    relation: { contains: releasePageId },
                });
            }
            const entryPages = await queryAll(notion, {
                database_id: project.databases.manualEntriesDatabaseId,
                filter: { and: manualFilters },
                page_size: 100,
            });
            const entries = [];
            for (const page of entryPages.slice(0, maxEntries)) {
                const properties = page.properties ?? {};
                entries.push({
                    id: page.id,
                    title: getTitleValue(properties, "Entry Title") ?? `Entry ${page.id}`,
                    entryType: getSelectName(properties, "Entry Type") ?? "",
                    audience: getSelectName(properties, "Audience") ?? "Internal",
                    confidenceScore: getNumberValue(properties, "Confidence Score"),
                    body: await loadEntryBodySummary(notion, page.id),
                });
            }
            const changelogMarkdown = buildChangelogMarkdown({
                projectName: project.projectName,
                releaseVersion,
                entries,
            });
            const sectionCounts = {
                userImpact: entries.filter((entry) => sectionFor(entry.entryType, entry.audience) === "user").length,
                adminOperations: entries.filter((entry) => sectionFor(entry.entryType, entry.audience) === "admin").length,
                developerNotes: entries.filter((entry) => sectionFor(entry.entryType, entry.audience) === "developer").length,
            };
            logToolEvent({
                level: "info",
                tool: "generate_release_changelog",
                stage: "success",
                traceId,
                message: "Generated release changelog",
                data: {
                    projectId,
                    releaseVersion,
                    releaseLinked: Boolean(releasePageId),
                    entryCount: entries.length,
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
                            releaseLinked: Boolean(releasePageId),
                            entryCount: entries.length,
                            sectionCounts,
                            changelogMarkdown,
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logToolEvent({
                level: "error",
                tool: "generate_release_changelog",
                stage: "failure",
                traceId,
                message: "Failed to generate release changelog",
                data: { projectId, releaseVersion, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
            });
            throwAsMcpToolError({
                tool: "generate_release_changelog",
                traceId,
                error,
                defaultCode: "GENERATE_RELEASE_CHANGELOG_FAILED",
            });
        }
    });
}
