import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { createNotionClient } from "../lib/notion-client.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { getStateStore } from "../lib/state-store.js";

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
type ChangelogEntry = {
    id: string;
    title: string;
    entryType: string;
    audience: string;
    confidenceScore: number | null;
    body: string;
};
type BuildChangelogMarkdownInput = { projectName: string; releaseVersion: string; entries: ChangelogEntry[] };
type GenerateReleaseChangelogInput = {
    projectId: string;
    releaseVersion: string;
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
function getNumberValue(properties: PropertyMap, key: string): number | null {
    const value = properties[key];
    return typeof value === "object" && value !== null && typeof (value as { number?: unknown }).number === "number"
        ? (value as { number: number }).number
        : null;
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
async function loadEntryBodySummary(notion: NotionClientLike, pageId: string): Promise<string> {
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
    for (const block of response.results) {
        if (block.type !== "paragraph") {
            continue;
        }
        const text = (block.paragraph?.rich_text ?? []).map((part: RichTextPart) => part.plain_text ?? "").join(" ").trim();
        if (text.length > 0) {
            return text.length > 220 ? `${text.slice(0, 220)}...` : text;
        }
    }
    return "";
}
function sectionFor(entryType: string, audience: string): "user" | "admin" | "developer" {
    if (entryType === "Developer Note" || audience === "Internal") {
        return "developer";
    }
    if (entryType === "Admin Guide" || audience === "Admin") {
        return "admin";
    }
    return "user";
}
function formatEntryLine(entry: ChangelogEntry): string {
    const score = typeof entry.confidenceScore === "number" ? ` (confidence ${entry.confidenceScore})` : "";
    return entry.body.length > 0 ? `- ${entry.title}${score}: ${entry.body}` : `- ${entry.title}${score}`;
}
function buildChangelogMarkdown(input: BuildChangelogMarkdownInput): string {
    const user: string[] = [];
    const admin: string[] = [];
    const developer: string[] = [];
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
    const section = (title: string, lines: string[]) => [
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
export function registerGenerateReleaseChangelogTool(server: McpServer): void {
    server.tool("generate_release_changelog", "Generates a release changelog markdown from approved/published manual entries linked to a release.", {
        projectId: z.string(),
        releaseVersion: z.string().min(1),
        maxEntries: z.number().int().positive().max(200).default(50),
        traceId: z.string().optional(),
    }, async ({ projectId, releaseVersion, maxEntries = 50, traceId: incomingTraceId }: GenerateReleaseChangelogInput) => {
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
            const releasePageId = releasePages[0]?.id ?? null;
            const manualFilters: unknown[] = [
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
            const entries: ChangelogEntry[] = [];
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
