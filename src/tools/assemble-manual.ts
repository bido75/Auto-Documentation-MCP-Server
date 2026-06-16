import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { composeManualDocument, type AssembledManualAudience, type ManualAssemblyEntry } from "../lib/manual-assembler.js";
import { extractManualContentFromBlocks } from "../lib/manual-blocks.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { createNotionClient } from "../lib/notion-client.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { getStateStore } from "../lib/state-store.js";

type PropertyMap = Record<string, unknown>;
type PageReference = { id: string; url?: string; properties?: PropertyMap };
type QueryInput = { database_id: string; filter?: unknown; page_size?: number; start_cursor?: string };
type QueryResponse = { results: PageReference[]; has_more?: boolean; next_cursor?: string | null };
type RichTextPart = { plain_text?: string; text?: { content?: string } };
type ManualContentBlock = {
  id?: string;
  type?: string;
  paragraph?: { rich_text?: RichTextPart[] };
  image?: { type?: "external" | "file"; external?: { url?: string }; file?: { url?: string }; caption?: RichTextPart[] };
};
type BlockListResponse = { results: ManualContentBlock[]; has_more?: boolean; next_cursor?: string | null };
type BlockAppendInput = { block_id: string; children: ReturnType<typeof composeManualDocument>["blocks"] };
type NotionClientLike = {
  databases: { query(input: QueryInput): Promise<QueryResponse> };
  pages: {
    create(input: {
      parent: { page_id: string };
      properties: Record<string, { title: Array<{ text: { content: string } }> }>;
      children: ReturnType<typeof composeManualDocument>["blocks"];
    }): Promise<{ id: string; url?: string }>;
    update(input: {
      page_id: string;
      properties: Record<string, { title: Array<{ text: { content: string } }> }>;
    }): Promise<{ id: string; url?: string }>;
  };
  blocks: {
    delete?: (input: { block_id: string }) => Promise<unknown>;
    children: {
      list(input: { block_id: string; page_size: number; start_cursor?: string }): Promise<BlockListResponse>;
      append(input: BlockAppendInput): Promise<unknown>;
    };
  };
};

type AssembleManualInput = {
  projectId: string;
  targetParentPageId?: string;
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

function hasProjectRelation(properties: PropertyMap, projectPageId: string): boolean {
  const value = properties.Project;
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const relation = (value as { relation?: Array<{ id?: string }> }).relation ?? [];
  return relation.some((item) => item.id === projectPageId);
}

function normalizeAudience(value: string | null): ManualAssemblyEntry["audience"] {
  return value === "User" || value === "Admin" || value === "Both" || value === "Internal" ? value : "Internal";
}

function normalizeStatus(value: string | null): ManualAssemblyEntry["status"] {
  return value === "Captured" || value === "Needs Review" || value === "Approved" || value === "Published" ? value : "Captured";
}

function pageTitleProperty(title: string): Record<string, { title: Array<{ text: { content: string } }> }> {
  return {
    title: {
      title: [{ text: { content: title } }],
    },
  };
}

async function queryAll(notion: NotionClientLike, input: QueryInput): Promise<PageReference[]> {
  const results: PageReference[] = [];
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

async function listAllBlocks(notion: NotionClientLike, pageId: string): Promise<ManualContentBlock[]> {
  const results: ManualContentBlock[] = [];
  let cursor: string | undefined;
  do {
    const payload = {
      block_id: pageId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const response = await withNotionRetry(() => notion.blocks.children.list(payload), {
      operationName: "blocks.children.list",
      payload,
    });
    results.push(...response.results);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return results;
}

async function loadPublishedEntries(input: {
  notion: NotionClientLike;
  manualEntriesDatabaseId: string;
  projectPageId: string;
}): Promise<ManualAssemblyEntry[]> {
  const pages = await queryAll(input.notion, {
    database_id: input.manualEntriesDatabaseId,
    filter: {
      and: [
        { property: "Project", relation: { contains: input.projectPageId } },
        { property: "Status", status: { equals: "Published" } },
      ],
    },
    page_size: 100,
  });

  const entries: ManualAssemblyEntry[] = [];
  for (const page of pages) {
    const properties = page.properties ?? {};
    if (!hasProjectRelation(properties, input.projectPageId)) {
      continue;
    }
    const status = normalizeStatus(getStatusName(properties, "Status"));
    if (status !== "Published" && status !== "Approved") {
      continue;
    }
    const blocks = await listAllBlocks(input.notion, page.id);
    const content = extractManualContentFromBlocks(blocks);
    entries.push({
      id: page.id,
      title: getTitleValue(properties, "Entry Title") ?? `Manual entry ${page.id}`,
      entryType: getSelectName(properties, "Entry Type") ?? undefined,
      audience: normalizeAudience(getSelectName(properties, "Audience")),
      status,
      body: content.body,
    });
  }
  return entries;
}

async function clearExistingChildren(notion: NotionClientLike, pageId: string): Promise<void> {
  if (!notion.blocks.delete) {
    return;
  }
  const children = await listAllBlocks(notion, pageId);
  for (const child of children) {
    if (!child.id) {
      continue;
    }
    const childId = child.id;
    await withNotionRetry(() => notion.blocks.delete?.({ block_id: childId }) ?? Promise.resolve(), {
      operationName: "blocks.delete",
      payload: { block_id: childId },
    });
  }
}

async function upsertManualPage(input: {
  notion: NotionClientLike;
  parentPageId: string;
  existingPageId?: string;
  document: ReturnType<typeof composeManualDocument>;
}): Promise<{ pageId: string; url?: string }> {
  if (input.existingPageId) {
    const existingPageId = input.existingPageId;
    try {
      const updated = await withNotionRetry(() => input.notion.pages.update({
        page_id: existingPageId,
        properties: pageTitleProperty(input.document.title),
      }), {
        operationName: "pages.update",
        payload: { page_id: existingPageId },
      });
      await clearExistingChildren(input.notion, existingPageId);
      await withNotionRetry(() => input.notion.blocks.children.append({
        block_id: existingPageId,
        children: input.document.blocks,
      }), {
        operationName: "blocks.children.append",
        payload: { block_id: existingPageId, children: input.document.blocks },
      });
      return { pageId: updated.id, url: updated.url };
    } catch {
      // Stale local state should not block re-assembly; create a fresh manual page and persist it.
    }
  }

  const created = await withNotionRetry(() => input.notion.pages.create({
    parent: { page_id: input.parentPageId },
    properties: pageTitleProperty(input.document.title),
    children: input.document.blocks,
  }), {
    operationName: "pages.create",
    payload: { parent: { page_id: input.parentPageId }, properties: pageTitleProperty(input.document.title) },
  });
  return { pageId: created.id, url: created.url };
}

export function registerAssembleManualTool(server: McpServer): void {
  server.tool("assemble_manual", "Assembles published entries into one User Manual page and one Admin Manual page.", {
    projectId: z.string(),
    targetParentPageId: z.string().optional(),
    traceId: z.string().optional(),
  }, async ({ projectId, targetParentPageId, traceId: incomingTraceId }: AssembleManualInput) => {
    const traceId = resolveTraceId(incomingTraceId);
    const startedAt = Date.now();
    logToolEvent({
      level: "info",
      tool: "assemble_manual",
      stage: "start",
      traceId,
      message: "Assembling coherent manuals",
      data: { projectId, targetParentPageId: targetParentPageId ?? null },
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
      const parentPageId = targetParentPageId ?? project.projectPageId ?? project.parentPageId;
      const entries = await loadPublishedEntries({
        notion,
        manualEntriesDatabaseId: project.databases.manualEntriesDatabaseId,
        projectPageId,
      });
      const existing = await store.getAssembledManualPages(projectId);
      const documents = {
        user: composeManualDocument({ projectName: project.projectName, audience: "user", entries }),
        admin: composeManualDocument({ projectName: project.projectName, audience: "admin", entries }),
      };
      const manuals: Record<AssembledManualAudience, { pageId: string; url?: string; title: string; entryCount: number; sectionCount: number }> = {
        user: { pageId: "", title: documents.user.title, entryCount: 0, sectionCount: 0 },
        admin: { pageId: "", title: documents.admin.title, entryCount: 0, sectionCount: 0 },
      };

      const userPage = await upsertManualPage({
        notion,
        parentPageId,
        existingPageId: existing.userPageId,
        document: documents.user,
      });
      await store.setAssembledManualPage(projectId, "user", userPage.pageId);
      manuals.user = {
        pageId: userPage.pageId,
        url: userPage.url,
        title: documents.user.title,
        entryCount: documents.user.entryCount,
        sectionCount: documents.user.sectionCount,
      };

      const adminPage = await upsertManualPage({
        notion,
        parentPageId,
        existingPageId: existing.adminPageId,
        document: documents.admin,
      });
      await store.setAssembledManualPage(projectId, "admin", adminPage.pageId);
      manuals.admin = {
        pageId: adminPage.pageId,
        url: adminPage.url,
        title: documents.admin.title,
        entryCount: documents.admin.entryCount,
        sectionCount: documents.admin.sectionCount,
      };

      logToolEvent({
        level: "info",
        tool: "assemble_manual",
        stage: "success",
        traceId,
        message: "Assembled coherent manuals",
        data: { projectId, userPageId: manuals.user.pageId, adminPageId: manuals.admin.pageId, durationMs: Date.now() - startedAt },
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ traceId, projectId, manuals }, null, 2),
          },
        ],
      };
    } catch (error) {
      logToolEvent({
        level: "error",
        tool: "assemble_manual",
        stage: "failure",
        traceId,
        message: "Failed to assemble coherent manuals",
        data: { projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
      });
      throwAsMcpToolError({
        tool: "assemble_manual",
        traceId,
        error,
        defaultCode: "ASSEMBLE_MANUAL_FAILED",
      });
    }
  });
}
