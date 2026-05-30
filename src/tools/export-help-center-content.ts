import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { createNotionClient } from "../lib/notion-client.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { getStateStore } from "../lib/state-store.js";

type NotionQueryResult = {
  results: Array<{ id: string; properties?: Record<string, unknown> }>;
  has_more?: boolean;
  next_cursor?: string | null;
};

type ExportableEntry = {
  id: string;
  title: string;
  entryType: string;
  audience: "User" | "Admin" | "Both" | "Internal";
  status: "Captured" | "Needs Review" | "Approved" | "Published" | "Deprecated";
  body: string;
};

type HelpCenterArticle = {
  id: string;
  slug: string;
  title: string;
  audience: "User" | "Admin" | "Both";
  entryType: string;
  summary: string;
  body: string;
  sourceManualEntryId: string;
};

function getTitleValue(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key] as { title?: Array<{ text?: { content?: string } }> } | undefined;
  return value?.title?.[0]?.text?.content ?? null;
}

function getSelectName(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key] as { select?: { name?: string } } | undefined;
  return value?.select?.name ?? null;
}

function getStatusName(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key] as { status?: { name?: string } } | undefined;
  return value?.status?.name ?? null;
}

async function queryAll(notion: ReturnType<typeof createNotionClient>, input: Record<string, unknown>) {
  const results: Array<{ id: string; properties?: Record<string, unknown> }> = [];
  let cursor: string | undefined;

  do {
    const payload = {
      ...input,
      ...(cursor ? { start_cursor: cursor } : {}),
    };

    const response = (await withNotionRetry(() => notion.databases.query(payload as never), {
      operationName: "databases.query",
      payload,
    })) as unknown as NotionQueryResult;

    results.push(...response.results);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return results;
}

async function loadEntryBody(notion: ReturnType<typeof createNotionClient>, pageId: string): Promise<string> {
  const response = (await withNotionRetry(
    () =>
      notion.blocks.children.list({
        block_id: pageId,
        page_size: 100,
      }),
    {
      operationName: "blocks.children.list",
      payload: {
        block_id: pageId,
        page_size: 100,
      },
    },
  )) as {
    results: Array<{
      type?: string;
      paragraph?: { rich_text?: Array<{ plain_text?: string }> };
    }>;
  };

  const lines: string[] = [];
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

async function resolveReleasePageId(input: {
  notion: ReturnType<typeof createNotionClient>;
  releasesDatabaseId: string;
  projectPageId: string;
  releaseVersion?: string;
}): Promise<string | undefined> {
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

async function loadPublishedEntries(input: {
  notion: ReturnType<typeof createNotionClient>;
  manualEntriesDatabaseId: string;
  projectPageId: string;
  releasePageId?: string;
}): Promise<ExportableEntry[]> {
  const filters: Array<Record<string, unknown>> = [
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

  const entries: ExportableEntry[] = [];
  for (const page of pages) {
    const properties = page.properties ?? {};
    entries.push({
      id: page.id,
      title: getTitleValue(properties, "Entry Title") ?? `Entry ${page.id}`,
      entryType: getSelectName(properties, "Entry Type") ?? "",
      audience: (getSelectName(properties, "Audience") ?? "Internal") as ExportableEntry["audience"],
      status: (getStatusName(properties, "Status") ?? "Captured") as ExportableEntry["status"],
      body: await loadEntryBody(input.notion, page.id),
    });
  }

  return entries;
}

function audienceIncluded(entryAudience: ExportableEntry["audience"], audience: "user" | "admin" | "both") {
  if (entryAudience === "Internal") {
    return false;
  }

  if (audience === "both") {
    return true;
  }

  if (audience === "user") {
    return entryAudience === "User" || entryAudience === "Both";
  }

  return entryAudience === "Admin" || entryAudience === "Both";
}

function toSlug(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

  return normalized || "article";
}

function firstSentence(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }

  const sentence = trimmed.split(/[\n.!?]/)[0]?.trim() ?? "";
  return sentence.length > 180 ? `${sentence.slice(0, 177)}...` : sentence;
}

function buildHelpCenter(input: { projectId: string; releaseVersion?: string; audience: "user" | "admin" | "both"; entries: ExportableEntry[] }) {
  const filtered = input.entries.filter((entry) => audienceIncluded(entry.audience, input.audience));

  const sectionsMap = new Map<string, HelpCenterArticle[]>();
  for (const entry of filtered) {
    const sectionTitle = entry.entryType || "General";
    const article: HelpCenterArticle = {
      id: `${input.projectId}:${entry.id}`,
      slug: toSlug(`${sectionTitle}-${entry.title}`),
      title: entry.title,
      audience: entry.audience as "User" | "Admin" | "Both",
      entryType: sectionTitle,
      summary: firstSentence(entry.body),
      body: entry.body,
      sourceManualEntryId: entry.id,
    };

    const existing = sectionsMap.get(sectionTitle);
    if (existing) {
      existing.push(article);
    } else {
      sectionsMap.set(sectionTitle, [article]);
    }
  }

  const sections = [...sectionsMap.entries()].map(([title, articles]) => ({
    id: toSlug(title),
    title,
    articleCount: articles.length,
    articles,
  }));

  const articleCount = sections.reduce((count, section) => count + section.articleCount, 0);

  return {
    version: "1",
    projectId: input.projectId,
    releaseVersion: input.releaseVersion ?? null,
    audience: input.audience,
    generatedAt: new Date().toISOString(),
    sectionCount: sections.length,
    articleCount,
    sections,
  };
}

export function registerExportHelpCenterContentTool(server: McpServer) {
  server.tool(
    "export_help_center_content",
    "Exports published manual entries as structured in-app help center JSON content.",
    {
      projectId: z.string(),
      audience: z.enum(["user", "admin", "both"]).default("both"),
      releaseVersion: z.string().optional(),
      outputPath: z.string().optional(),
      traceId: z.string().optional(),
    },
    async ({ projectId, audience, releaseVersion, outputPath, traceId: incomingTraceId }) => {
      const traceId = resolveTraceId(incomingTraceId);
      const startedAt = Date.now();

      logToolEvent({
        level: "info",
        tool: "export_help_center_content",
        stage: "start",
        traceId,
        message: "Exporting help center content",
        data: { projectId, audience, releaseVersion: releaseVersion ?? null, outputPath: outputPath ?? null },
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

        const payload = buildHelpCenter({
          projectId,
          audience,
          releaseVersion,
          entries,
        });

        if (outputPath) {
          await mkdir(dirname(outputPath), { recursive: true });
          await writeFile(outputPath, JSON.stringify(payload, null, 2), "utf-8");
        }

        logToolEvent({
          level: "info",
          tool: "export_help_center_content",
          stage: "success",
          traceId,
          message: "Exported help center content",
          data: {
            projectId,
            audience,
            releaseVersion: releaseVersion ?? null,
            outputPath: outputPath ?? null,
            sectionCount: payload.sectionCount,
            articleCount: payload.articleCount,
            durationMs: Date.now() - startedAt,
          },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  traceId,
                  ...payload,
                  outputPath: outputPath ?? null,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "export_help_center_content",
          stage: "failure",
          traceId,
          message: "Failed to export help center content",
          data: { projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });

        throwAsMcpToolError({
          tool: "export_help_center_content",
          traceId,
          error,
          defaultCode: "EXPORT_HELP_CENTER_CONTENT_FAILED",
        });
      }
    },
  );
}
