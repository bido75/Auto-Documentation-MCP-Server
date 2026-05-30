import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { renderManualMarkdown } from "../lib/export.js";
import { blocksToMarkdown, fetchAllBlocks } from "../lib/notion-block-exporter.js";
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
  title: string;
  entryType: string;
  audience: "User" | "Admin" | "Both" | "Internal";
  status: "Captured" | "Needs Review" | "Approved" | "Published" | "Deprecated";
  body: string;
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
  const blocks = await fetchAllBlocks(notion as never, pageId);
  return blocksToMarkdown(blocks);
}

async function loadPublishedEntries(input: {
  notion: ReturnType<typeof createNotionClient>;
  manualEntriesDatabaseId: string;
  projectPageId: string;
}): Promise<ExportableEntry[]> {
  const pages = await queryAll(input.notion, {
    database_id: input.manualEntriesDatabaseId,
    filter: {
      and: [
        {
          property: "Project",
          relation: { contains: input.projectPageId },
        },
        {
          property: "Status",
          status: { equals: "Published" },
        },
      ],
    },
    page_size: 100,
  });

  const entries: ExportableEntry[] = [];
  for (const page of pages) {
    const properties = page.properties ?? {};
    entries.push({
      title: getTitleValue(properties, "Entry Title") ?? `Entry ${page.id}`,
      entryType: getSelectName(properties, "Entry Type") ?? "",
      audience: (getSelectName(properties, "Audience") ?? "Internal") as ExportableEntry["audience"],
      status: (getStatusName(properties, "Status") ?? "Captured") as ExportableEntry["status"],
      body: await loadEntryBody(input.notion, page.id),
    });
  }

  return entries;
}

export function registerExportManualMarkdownTool(server: McpServer) {
  server.tool(
    "export_manual_markdown",
    "Exports published manual entries into a markdown document.",
    {
      projectId: z.string(),
      projectName: z.string().optional(),
      audience: z.enum(["user", "admin", "both"]).default("both"),
      traceId: z.string().optional(),
      entries: z
        .array(
          z.object({
            title: z.string(),
            entryType: z.string(),
            audience: z.enum(["User", "Admin", "Both", "Internal"]),
            status: z.enum(["Captured", "Needs Review", "Approved", "Published", "Deprecated"]),
            body: z.string(),
          }),
        )
        .optional(),
    },
    async ({ projectId, projectName, audience, entries, traceId: incomingTraceId }) => {
      const traceId = resolveTraceId(incomingTraceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "export_manual_markdown",
        stage: "start",
        traceId,
        message: "Exporting manual markdown",
        data: { projectId, audience },
      });

      try {
        const store = getStateStore();
        const project = await store.getProject(projectId);
        if (!project) {
          throw new Error("Unknown projectId. Run initialize_project_manual first.");
        }

        const notion = createNotionClient();
        await runProjectPreflight({ notion, project });

        const sourceEntries =
          entries ??
          (await loadPublishedEntries({
            notion,
            manualEntriesDatabaseId: project.databases.manualEntriesDatabaseId,
            projectPageId: project.projectPageId ?? project.projectId,
          }));

        logToolEvent({
          level: "info",
          tool: "export_manual_markdown",
          stage: "success",
          traceId,
          message: "Exported manual markdown",
          data: { projectId, entryCount: sourceEntries.length, durationMs: Date.now() - startedAt },
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  traceId,
                  projectId,
                  markdown: renderManualMarkdown({ projectName: projectName ?? project.projectName, audience, entries: sourceEntries }),
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
          tool: "export_manual_markdown",
          stage: "failure",
          traceId,
          message: "Failed to export manual markdown",
          data: { projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "export_manual_markdown",
          traceId,
          error,
          defaultCode: "EXPORT_MANUAL_MARKDOWN_FAILED",
        });
      }
    },
  );
}
