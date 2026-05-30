import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { createNotionClient } from "../lib/notion-client.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { getStateStore } from "../lib/state-store.js";
import { buildMarkdownManual } from "../packaging/manual-packager.js";
import type { EntryType } from "../types.js";
import { buildManualArtifactPageBlocks } from "../notion/manual-layout.js";

type NotionQueryResult = {
  results: Array<{ id: string; properties?: Record<string, unknown> }>;
  has_more?: boolean;
  next_cursor?: string | null;
};

type PackableEntry = {
  pageId: string;
  title: string;
  body: string;
  entryType: EntryType | string;
  audience: "User" | "Admin" | "Both" | "Internal";
  status: "Captured" | "Needs Review" | "Approved" | "Published" | "Deprecated";
  featureIds: string[];
  routes: string[];
  apiEndpoints: string[];
};

type NotionBlock = Record<string, unknown>;

function isEntryIncluded(entry: PackableEntry, audience: "user" | "admin" | "both") {
  if (!(entry.status === "Published" || entry.status === "Approved")) {
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

function getExclusionReason(entry: PackableEntry, audience: "user" | "admin" | "both") {
  if (!(entry.status === "Published" || entry.status === "Approved")) {
    return `${entry.title}: status '${entry.status}' is not publishable.`;
  }

  return `${entry.title}: audience '${entry.audience}' is excluded for audience '${audience}'.`;
}

function getUrlValue(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key] as { url?: string | null } | undefined;
  return typeof value?.url === "string" && value.url.length > 0 ? value.url : null;
}

function toDashedPageId(raw: string): string {
  const normalized = raw.replace(/[^a-zA-Z0-9]/g, "");
  if (!/^[a-fA-F0-9]{32}$/.test(normalized)) {
    return raw;
  }

  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20)}`;
}

function extractPageIdFromUrl(url: string): string | null {
  const hexIdMatch = url.match(/([a-fA-F0-9]{32})/);
  if (hexIdMatch?.[1]) {
    return toDashedPageId(hexIdMatch[1]);
  }

  const tail = url.split("/").filter(Boolean).pop();
  return tail ? decodeURIComponent(tail) : null;
}

export function buildManualPageBlocks(input: {
  releaseVersion: string;
  audience: "user" | "admin" | "both";
  entries: PackableEntry[];
}): NotionBlock[] {
  return buildManualArtifactPageBlocks(input);
}

async function clearExistingPageBlocks(notion: ReturnType<typeof createNotionClient>, pageId: string) {
  const blocksApi = notion.blocks as unknown as {
    delete?: (input: { block_id: string }) => Promise<unknown>;
    children: { list: (input: { block_id: string; page_size?: number; start_cursor?: string }) => Promise<unknown> };
  };

  if (!blocksApi?.delete) {
    return;
  }

  let cursor: string | undefined;
  do {
    const listPayload = { block_id: pageId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) };
    const listed = (await withNotionRetry(() => blocksApi.children.list(listPayload), {
      operationName: "blocks.children.list",
      payload: listPayload,
    })) as {
      results: Array<{ id: string }>;
      has_more?: boolean;
      next_cursor?: string | null;
    };

    for (const block of listed.results) {
      const deletePayload = { block_id: block.id };
      await withNotionRetry(() => blocksApi.delete!(deletePayload), {
        operationName: "blocks.delete",
        payload: deletePayload,
      });
    }

    cursor = listed.has_more ? listed.next_cursor ?? undefined : undefined;
  } while (cursor);
}

async function upsertManualArtifactPage(input: {
  notion: ReturnType<typeof createNotionClient>;
  projectName: string;
  releaseVersion: string;
  parentPageId: string;
  existingManualUrl: string | null;
  audience: "user" | "admin" | "both";
  entries: PackableEntry[];
}): Promise<{ pageId: string; url: string }> {
  const blocks = buildManualPageBlocks({
    releaseVersion: input.releaseVersion,
    audience: input.audience,
    entries: input.entries,
  });

  const title = `${input.projectName} - ${input.releaseVersion} Manual`;
  let pageId = input.existingManualUrl ? extractPageIdFromUrl(input.existingManualUrl) : null;
  let pageUrl = input.existingManualUrl ?? "";

  if (!pageId) {
    const createPagePayload = {
      parent: { page_id: input.parentPageId },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title } }],
        },
      },
      children: blocks,
    };

    const created = await withNotionRetry(() => input.notion.pages.create(createPagePayload as never), {
      operationName: "pages.create",
      payload: createPagePayload,
    });

    pageId = created.id;
    pageUrl = "url" in created && typeof created.url === "string" ? created.url : `https://notion.so/${created.id.replace(/-/g, "")}`;
    return { pageId, url: pageUrl };
  }

  const updatePagePayload = {
    page_id: pageId,
    properties: {
      title: {
        title: [{ type: "text", text: { content: title } }],
      },
    },
  };

  const updated = await withNotionRetry(() => input.notion.pages.update(updatePagePayload as never), {
    operationName: "pages.update",
    payload: updatePagePayload,
  });

  await clearExistingPageBlocks(input.notion, pageId);

  const appendPayload = {
    block_id: pageId,
    children: blocks,
  };
  await withNotionRetry(() => input.notion.blocks.children.append(appendPayload as never), {
    operationName: "blocks.children.append",
    payload: appendPayload,
  });

  if ("url" in updated && typeof updated.url === "string") {
    pageUrl = updated.url;
  } else if (!pageUrl) {
    pageUrl = `https://notion.so/${pageId.replace(/-/g, "")}`;
  }

  return { pageId, url: pageUrl };
}

function getStatusName(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key] as { status?: { name?: string } } | undefined;
  return value?.status?.name ?? null;
}

function getSelectName(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key] as { select?: { name?: string } } | undefined;
  return value?.select?.name ?? null;
}

function getTitleValue(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key] as { title?: Array<{ text?: { content?: string } }> } | undefined;
  return value?.title?.[0]?.text?.content ?? null;
}

function getRelationIds(properties: Record<string, unknown>, key: string): string[] {
  const value = properties[key] as { relation?: Array<{ id?: string }> } | undefined;
  return (value?.relation ?? []).map((item) => item.id).filter((id): id is string => typeof id === "string");
}

function getRichTextLines(properties: Record<string, unknown>, key: string): string[] {
  const value = properties[key] as { rich_text?: Array<{ plain_text?: string; text?: { content?: string } }> } | undefined;
  const text = (value?.rich_text ?? [])
    .map((item) => item.plain_text ?? item.text?.content ?? "")
    .join("")
    .trim();

  return text.length > 0 ? text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
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
  const blocksListPayload = { block_id: pageId, page_size: 100 };
  const response = (await withNotionRetry(() => notion.blocks.children.list(blocksListPayload), {
    operationName: "blocks.children.list",
    payload: blocksListPayload,
  })) as {
    results: Array<{
      id?: string;
      type?: string;
      has_children?: boolean;
      paragraph?: { rich_text?: Array<{ plain_text?: string }> };
      heading_2?: { rich_text?: Array<{ plain_text?: string }> };
      heading_3?: { rich_text?: Array<{ plain_text?: string }> };
      callout?: { rich_text?: Array<{ plain_text?: string }> };
      bulleted_list_item?: { rich_text?: Array<{ plain_text?: string }> };
      numbered_list_item?: { rich_text?: Array<{ plain_text?: string }> };
      code?: { rich_text?: Array<{ plain_text?: string }> };
      toggle?: { rich_text?: Array<{ plain_text?: string }> };
    }>;
    has_more?: boolean;
    next_cursor?: string | null;
  };

  const textOf = (parts?: Array<{ plain_text?: string }>) => parts?.map((part) => part.plain_text ?? "").join("").trim() ?? "";
  const sections: string[] = [];
  let numberedIndex = 0;

  const readToggleChildren = async (blockId: string) => {
    const childPayload = { block_id: blockId, page_size: 100 };
    const childResponse = (await withNotionRetry(() => notion.blocks.children.list(childPayload), {
      operationName: "blocks.children.list",
      payload: childPayload,
    })) as {
      results: Array<{ paragraph?: { rich_text?: Array<{ plain_text?: string }> } }>;
    };

    return childResponse.results
      .map((child) => textOf(child.paragraph?.rich_text))
      .filter((text) => text.length > 0)
      .join("\n");
  };

  for (const block of response.results) {
    if (block.type === "callout") {
      const text = textOf(block.callout?.rich_text);
      if (!text || text.startsWith("Audience:")) {
        continue;
      }

      const label = sections.length === 0 ? "What users can do now" : "Errors or edge states";
      if (!sections.some((section) => section.startsWith(`${label}:\n`))) {
        sections.push(`${label}:\n${text}`);
      }
      continue;
    }

    if (block.type === "numbered_list_item") {
      const text = textOf(block.numbered_list_item?.rich_text);
      if (!text) {
        continue;
      }

      const labels = ["Where to go", "What action to take", "Expected result"];
      const label = labels[numberedIndex] ?? `Step ${numberedIndex + 1}`;
      numberedIndex += 1;
      sections.push(`${label}:\n${text}`);
      continue;
    }

    if (block.type === "paragraph") {
      const text = textOf(block.paragraph?.rich_text);
      if (!text) {
        continue;
      }

      const previousSection = sections.at(-1) ?? "";
      if (previousSection.startsWith("Permissions and integrations:\n") || previousSection.startsWith("How to verify:\n")) {
        sections[sections.length - 1] = `${previousSection}\n${text}`;
      } else {
        sections.push(text);
      }
      continue;
    }

    if (block.type === "bulleted_list_item") {
      const text = textOf(block.bulleted_list_item?.rich_text);
      if (text) {
        sections.push(`Operational workflow change:\n${text}`);
      }
      continue;
    }

    if (block.type === "heading_3") {
      const heading = textOf(block.heading_3?.rich_text);
      if (heading === "Permissions & Integrations") {
        sections.push("Permissions and integrations:\n");
      } else if (heading === "How to verify") {
        sections.push("How to verify:\n");
      }
      continue;
    }

    if (block.type === "toggle" && block.id && block.has_children) {
      const text = await readToggleChildren(block.id);
      if (text) {
        sections.push(`Troubleshooting:\n${text}`);
      }
    }
  }

  return sections.filter((section) => section.trim().length > 0).join("\n\n");
}

async function loadManualEntriesFromNotion(input: {
  notion: ReturnType<typeof createNotionClient>;
  projectManualEntriesDatabaseId: string;
  projectPageId: string;
  releasePageId?: string;
}): Promise<PackableEntry[]> {
  const filters: Array<Record<string, unknown>> = [
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
    database_id: input.projectManualEntriesDatabaseId,
    filter: { and: filters },
    page_size: 100,
  });

  const entries: PackableEntry[] = [];
  for (const page of pages) {
    const properties = page.properties ?? {};
    const audience = getSelectName(properties, "Audience") ?? "Internal";
    const status = getStatusName(properties, "Status") ?? "Captured";
    const title = getTitleValue(properties, "Entry Title") ?? `Entry ${page.id}`;
    const entryType = getSelectName(properties, "Entry Type") ?? "Developer Note";
    const featureIds = getRelationIds(properties, "Feature");
    const body = await loadEntryBody(input.notion, page.id);

    entries.push({
      pageId: page.id,
      title,
      body,
      entryType,
      audience: audience as PackableEntry["audience"],
      status: status as PackableEntry["status"],
      featureIds,
      routes: getRichTextLines(properties, "Routes / URLs"),
      apiEndpoints: getRichTextLines(properties, "API Endpoints"),
    });
  }

  return entries;
}

export function registerPackageManualTool(server: McpServer) {
  server.tool(
    "package_manual",
    "Builds a release-ready manual from approved/published entries.",
    {
      projectId: z.string(),
      projectName: z.string().optional(),
      releaseVersion: z.string(),
      audience: z.enum(["user", "admin", "both"]),
      format: z.enum(["notion_page", "markdown"]),
      traceId: z.string().optional(),
      manualEntryIds: z.array(z.string()).optional(),
      includedFeatureIds: z.array(z.string()).optional(),
      entries: z
        .array(
        z.object({
          title: z.string(),
          body: z.string(),
          audience: z.enum(["User", "Admin", "Both", "Internal"]),
          status: z.enum(["Captured", "Needs Review", "Approved", "Published", "Deprecated"]),
          }),
        )
        .optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "package_manual",
        stage: "start",
        traceId,
        message: "Packaging release manual",
        data: { projectId: input.projectId, releaseVersion: input.releaseVersion, format: input.format, audience: input.audience },
      });

      try {
        const store = getStateStore();
        const project = await store.getProject(input.projectId);
        if (!project) {
          throw new Error("Unknown projectId. Run initialize_project_manual first.");
        }

        const notion = createNotionClient();
        await runProjectPreflight({ notion, project });
        const projectPageId = project.projectPageId ?? project.projectId;

        const releaseQueryPayload = {
        database_id: project.databases.releasesDatabaseId,
        filter: {
          property: "Release Version",
          title: { equals: input.releaseVersion },
        },
        page_size: 1,
      };

        const existingRelease = await withNotionRetry(() => notion.databases.query(releaseQueryPayload), {
          operationName: "databases.query",
          payload: releaseQueryPayload,
        });

        const existingReleasePage = existingRelease.results[0];
        let releasePageId = existingReleasePage?.id;
        let existingManualUrl: string | null = null;

        if (existingReleasePage && "properties" in existingReleasePage) {
          existingManualUrl = getUrlValue(existingReleasePage.properties ?? {}, "Manual URL");
        }

        const sourceEntries: PackableEntry[] = input.entries
        ? input.entries.map((entry) => ({
            pageId: "",
            title: entry.title,
            body: entry.body,
            entryType: "Developer Note",
            audience: entry.audience,
            status: entry.status,
            featureIds: [],
            routes: [],
            apiEndpoints: [],
          }))
        : await loadManualEntriesFromNotion({
            notion,
            projectManualEntriesDatabaseId: project.databases.manualEntriesDatabaseId,
            projectPageId,
            releasePageId,
          });

        const selectedAudience = input.audience === "both" ? "Both" : input.audience === "user" ? "User" : "Admin";
        const markdown = buildMarkdownManual({
        projectName: input.projectName ?? project.projectName,
        releaseVersion: input.releaseVersion,
        audience: selectedAudience,
        entries: sourceEntries,
      });

        const includedEntries = sourceEntries.filter((entry) => isEntryIncluded(entry, input.audience));
        const includedCount = includedEntries.length;
        const excludedCount = sourceEntries.length - includedCount;
        const excludedReasons = sourceEntries
          .filter((entry) => !isEntryIncluded(entry, input.audience))
          .map((entry) => getExclusionReason(entry, input.audience));

        const userEntriesCount = sourceEntries.filter(
        (entry) =>
          (entry.status === "Published" || entry.status === "Approved") &&
          (entry.audience === "User" || entry.audience === "Both"),
      ).length;
        const adminEntriesCount = sourceEntries.filter(
        (entry) =>
          (entry.status === "Published" || entry.status === "Approved") &&
          (entry.audience === "Admin" || entry.audience === "Both"),
      ).length;

        const includedFeatureIds =
        input.includedFeatureIds ??
        Array.from(
          new Set(
            sourceEntries.flatMap((entry) => (isEntryIncluded(entry, "both") ? entry.featureIds : [])),
          ),
        );

        let releasePageUrl: string | undefined;

        if (!releasePageId) {
        const createReleasePayload = {
          parent: { database_id: project.databases.releasesDatabaseId },
          properties: {
            "Release Version": { title: [{ text: { content: input.releaseVersion } }] },
            Status: { status: { name: "Ready" } },
            Project: { relation: [{ id: projectPageId }] },
            ...(includedFeatureIds.length > 0
              ? { "Included Features": { relation: includedFeatureIds.map((id) => ({ id })) } }
              : {}),
            "User Entries Count": { number: userEntriesCount },
            "Admin Entries Count": { number: adminEntriesCount },
          },
        };

          const created = await withNotionRetry(() => notion.pages.create(createReleasePayload), {
            operationName: "pages.create",
            payload: createReleasePayload,
          });
          releasePageId = created.id;
          if ("url" in created && typeof created.url === "string") {
            releasePageUrl = created.url;
          }
        }

        const updateReleasePayload = {
        page_id: releasePageId,
        properties: {
          Status: { status: { name: "Ready" } },
          Project: { relation: [{ id: projectPageId }] },
          ...(includedFeatureIds.length > 0
            ? { "Included Features": { relation: includedFeatureIds.map((id) => ({ id })) } }
            : {}),
          "User Entries Count": { number: userEntriesCount },
          "Admin Entries Count": { number: adminEntriesCount },
        },
      };

        let updatedRelease = await withNotionRetry(() => notion.pages.update(updateReleasePayload), {
          operationName: "pages.update",
          payload: updateReleasePayload,
        });

        if (!releasePageUrl && "url" in updatedRelease && typeof updatedRelease.url === "string") {
          releasePageUrl = updatedRelease.url;
        }

        if (!releasePageUrl && releasePageId) {
          releasePageUrl = `https://notion.so/${releasePageId.replace(/-/g, "")}`;
        }

        const manualEntryIds = input.manualEntryIds ?? sourceEntries.map((entry) => entry.pageId).filter((id) => id.length > 0);

        for (const manualEntryId of manualEntryIds) {
        const updateManualReleasePayload = {
          page_id: manualEntryId,
          properties: {
            Release: { relation: [{ id: releasePageId }] },
          },
        };

          await withNotionRetry(() => notion.pages.update(updateManualReleasePayload), {
            operationName: "pages.update",
            payload: updateManualReleasePayload,
          });
        }

        logToolEvent({
          level: "info",
          tool: "package_manual",
          stage: "success",
          traceId,
          message: "Packaged release manual",
          data: {
            projectId: input.projectId,
            releaseVersion: input.releaseVersion,
            includedEntryCount: includedCount,
            excludedEntryCount: excludedCount,
            durationMs: Date.now() - startedAt,
          },
        });

        let output = input.format === "markdown" ? markdown : releasePageUrl;

        if (input.format === "notion_page") {
          const artifact = await upsertManualArtifactPage({
            notion,
            projectName: input.projectName ?? project.projectName,
            releaseVersion: input.releaseVersion,
            parentPageId: project.parentPageId,
            existingManualUrl,
            audience: input.audience,
            entries: sourceEntries,
          });

          const updateManualUrlPayload = {
            page_id: releasePageId,
            properties: {
              "Manual URL": { url: artifact.url },
            },
          };
          updatedRelease = await withNotionRetry(() => notion.pages.update(updateManualUrlPayload), {
            operationName: "pages.update",
            payload: updateManualUrlPayload,
          });

          releasePageUrl = artifact.url;
          output = artifact.url;
          if ("url" in updatedRelease && typeof updatedRelease.url === "string") {
            // Keep releasePageUrl pointing at artifact URL, while still reading update response for robustness.
            void updatedRelease.url;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  traceId,
                  format: input.format,
                  projectId: input.projectId,
                  releasePageId,
                  includedEntryCount: includedCount,
                  excludedEntryCount: excludedCount,
                  excludedReasons,
                  output,
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
          tool: "package_manual",
          stage: "failure",
          traceId,
          message: "Failed to package release manual",
          data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "package_manual",
          traceId,
          error,
          defaultCode: "PACKAGE_MANUAL_FAILED",
        });
      }
    },
  );
}
