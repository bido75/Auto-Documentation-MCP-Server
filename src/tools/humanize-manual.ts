import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchAllBlocks, blocksToMarkdown } from "../lib/notion-block-exporter.js";
import { humanizeManualEntries, humanizeManualMarkdown, type HumanizerAudience, type HumanizerStrictness } from "../lib/manual-humanizer.js";
import { markdownBlocks } from "../lib/notion-blocks.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { createNotionClient } from "../lib/notion-client.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { getStateStore } from "../lib/state-store.js";

type QueryResultPage = { id: string; properties?: Record<string, unknown> };
type QueryResponse = { results: QueryResultPage[]; has_more?: boolean; next_cursor?: string | null };
type RichTextPart = { plain_text?: string; text?: { content?: string } };
type HumanizerBlock = {
  id: string;
  type: string;
  has_children?: boolean;
  heading_1?: { rich_text?: RichTextPart[] };
  heading_2?: { rich_text?: RichTextPart[] };
  heading_3?: { rich_text?: RichTextPart[] };
  paragraph?: { rich_text?: RichTextPart[] };
  bulleted_list_item?: { rich_text?: RichTextPart[] };
  numbered_list_item?: { rich_text?: RichTextPart[] };
  code?: { rich_text?: RichTextPart[]; language?: string };
  callout?: { rich_text?: RichTextPart[]; icon?: { emoji?: string } };
  quote?: { rich_text?: RichTextPart[] };
  toggle?: { rich_text?: RichTextPart[] };
};
type NotionHumanizerClient = {
  databases: {
    query(input: Record<string, unknown>): Promise<QueryResponse>;
  };
  blocks: {
    children: {
      list(input: { block_id: string; page_size: number; start_cursor?: string }): Promise<{ results: HumanizerBlock[]; has_more?: boolean; next_cursor?: string | null }>;
      append(input: { block_id: string; children: ReturnType<typeof markdownBlocks> }): Promise<unknown>;
    };
    delete?: (input: { block_id: string }) => Promise<unknown>;
  };
};

const modeSchema = z.enum(["prose", "code", "both"]).default("both");
const strictnessSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2);
const audienceSchema = z.enum(["developers", "end_users", "admins"]).default("developers");

function titleText(properties: Record<string, unknown> | undefined): string {
  const value = properties?.["Entry Title"];
  return (value as { title?: Array<{ plain_text?: string; text?: { content?: string } }> } | undefined)?.title?.[0]?.plain_text
    ?? (value as { title?: Array<{ text?: { content?: string } }> } | undefined)?.title?.[0]?.text?.content
    ?? "Untitled manual entry";
}

function statusFilter(targetEntries: "all" | "needs_review" | "published"): Record<string, unknown> | null {
  if (targetEntries === "all") {
    return null;
  }
  return {
    property: "Status",
    status: { equals: targetEntries === "needs_review" ? "Needs Review" : "Published" },
  };
}

async function queryAllManualEntries(input: {
  notion: NotionHumanizerClient;
  manualEntriesDatabaseId: string;
  projectPageId?: string;
  targetEntries: "all" | "needs_review" | "published";
}): Promise<QueryResultPage[]> {
  const filters = [
    ...(input.projectPageId ? [{ property: "Project", relation: { contains: input.projectPageId } }] : []),
    ...(statusFilter(input.targetEntries) ? [statusFilter(input.targetEntries) as Record<string, unknown>] : []),
  ];
  const results: QueryResultPage[] = [];
  let cursor: string | undefined;
  do {
    const payload = {
      database_id: input.manualEntriesDatabaseId,
      ...(filters.length > 0 ? { filter: filters.length === 1 ? filters[0] : { and: filters } } : {}),
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const response = (await withNotionRetry(() => input.notion.databases.query(payload), {
      operationName: "databases.query",
      payload,
    })) as unknown as QueryResponse;
    results.push(...response.results);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return results;
}

async function replacePageContent(input: { notion: NotionHumanizerClient; pageId: string; markdown: string }): Promise<void> {
  if (!input.notion.blocks.delete) {
    throw new Error("Notion client does not support blocks.delete; cannot update manual entry content in place.");
  }
  const blocks = await fetchAllBlocks(input.notion, input.pageId);
  for (const block of blocks) {
    await withNotionRetry(() => input.notion.blocks.delete?.({ block_id: block.id }) ?? Promise.resolve(), {
      operationName: "blocks.delete",
      payload: { block_id: block.id },
    });
  }
  const children = markdownBlocks(input.markdown);
  for (let index = 0; index < children.length; index += 100) {
    const slice = children.slice(index, index + 100);
    await withNotionRetry(() => input.notion.blocks.children.append({ block_id: input.pageId, children: slice }), {
      operationName: "blocks.children.append",
      payload: { block_id: input.pageId, children: slice },
    });
  }
}

export function registerHumanizeManualTool(server: McpServer): void {
  server.tool(
    "humanize_manual",
    "Polishes generated manual prose and code examples after synthesis and before packaging; can dry-run inline content or update Notion manual entries in place.",
    {
      projectId: z.string().optional(),
      manualEntriesDbId: z.string().optional(),
      targetEntries: z.enum(["all", "needs_review", "published"]).default("needs_review"),
      strictnessLevel: strictnessSchema,
      targetAudience: audienceSchema,
      voiceSample: z.string().optional(),
      dryRun: z.boolean().default(true),
      markdown: z.string().optional(),
      entries: z
        .array(
          z.object({
            title: z.string(),
            body: z.string(),
            audience: z.string().optional(),
            status: z.string().optional(),
          }),
        )
        .optional(),
      mode: modeSchema,
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "humanize_manual",
        stage: "start",
        traceId,
        message: "Humanizing manual content",
        data: {
          projectId: input.projectId ?? null,
          hasMarkdown: typeof input.markdown === "string",
          entryCount: input.entries?.length ?? 0,
          targetEntries: input.targetEntries,
          dryRun: input.dryRun,
          mode: input.mode,
        },
      });

      try {
        const options = {
          mode: input.mode,
          strictnessLevel: input.strictnessLevel as HumanizerStrictness,
          targetAudience: input.targetAudience as HumanizerAudience,
          ...(input.voiceSample ? { voiceSample: input.voiceSample } : {}),
        };

        const markdown = input.markdown ? humanizeManualMarkdown(input.markdown, options) : null;
        const entries = input.entries ? humanizeManualEntries(input.entries, options) : null;
        const notionFindings: Array<{ entryTitle: string; entryId: string; changed: boolean; updated: boolean }> = [];
        let pagesUpdated = 0;

        if (input.projectId || input.manualEntriesDbId) {
          const store = getStateStore();
          const project = input.projectId ? await store.getProject(input.projectId) : null;
          if (input.projectId && !project) {
            throw new Error("Unknown projectId. Run initialize_project_manual first.");
          }
          const manualEntriesDatabaseId = input.manualEntriesDbId ?? project?.databases.manualEntriesDatabaseId;
          if (!manualEntriesDatabaseId) {
            throw new Error("manualEntriesDbId is required when projectId is not provided.");
          }
          const rawNotion = createNotionClient();
          const notion = rawNotion as unknown as NotionHumanizerClient;
          if (project) {
            await runProjectPreflight({ notion: rawNotion, project });
          }
          const pages = await queryAllManualEntries({
            notion,
            manualEntriesDatabaseId,
            projectPageId: project?.projectPageId ?? project?.projectId,
            targetEntries: input.targetEntries,
          });
          for (const page of pages) {
            const original = blocksToMarkdown(await fetchAllBlocks(notion, page.id));
            if (!original.trim()) {
              continue;
            }
            const humanized = humanizeManualMarkdown(original, options);
            const changed = humanized.changed;
            if (changed && !input.dryRun) {
              await replacePageContent({ notion, pageId: page.id, markdown: humanized.text });
              pagesUpdated += 1;
            }
            notionFindings.push({ entryTitle: titleText(page.properties), entryId: page.id, changed, updated: changed && !input.dryRun });
          }
        }

        logToolEvent({
          level: "info",
          tool: "humanize_manual",
          stage: "success",
          traceId,
          message: "Humanized manual content",
          data: {
            markdownChanged: markdown?.changed ?? false,
            changedEntryCount: entries?.changedCount ?? 0,
            notionEntryCount: notionFindings.length,
            pagesUpdated,
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
                  dryRun: input.dryRun,
                  markdown: markdown?.text,
                  markdownChanged: markdown?.changed ?? false,
                  entries: entries?.entries,
                  changedEntryCount: entries?.changedCount ?? 0,
                  metrics: entries?.metrics ?? markdown?.metrics,
                  notion: {
                    processed: notionFindings.length,
                    pagesUpdated,
                    findings: notionFindings,
                  },
                  nextStep: input.dryRun ? "Review findings, then run again with dryRun=false." : "Ready for package_manual.",
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
          tool: "humanize_manual",
          stage: "failure",
          traceId,
          message: "Failed to humanize manual content",
          data: { error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({ tool: "humanize_manual", traceId, error, defaultCode: "HUMANIZE_MANUAL_FAILED" });
      }
    },
  );

  server.tool(
    "humanize_content",
    "Humanizes one markdown snippet inline and returns the cleaned content plus audit metrics.",
    {
      content: z.string(),
      strictnessLevel: strictnessSchema,
      targetAudience: audienceSchema,
      includeCodeBlocks: z.boolean().default(true),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      try {
        const includeCodeBlocks = input.includeCodeBlocks !== false;
        const result = humanizeManualMarkdown(input.content, {
          mode: includeCodeBlocks ? "both" : "prose",
          strictnessLevel: input.strictnessLevel as HumanizerStrictness,
          targetAudience: input.targetAudience as HumanizerAudience,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ traceId, humanized: result.text, changed: result.changed, metrics: result.metrics }, null, 2),
            },
          ],
        };
      } catch (error) {
        throwAsMcpToolError({ tool: "humanize_content", traceId, error, defaultCode: "HUMANIZE_CONTENT_FAILED" });
      }
    },
  );
}
