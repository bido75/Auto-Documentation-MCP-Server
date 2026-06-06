import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { createNotionClient } from "../lib/notion-client.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { getStateStore } from "../lib/state-store.js";
import { buildMarkdownManual } from "../packaging/manual-packager.js";

type NotionQueryResult = {
  results: Array<{ id: string; properties?: Record<string, unknown> }>;
  has_more?: boolean;
  next_cursor?: string | null;
};

type PackableEntry = {
  pageId: string;
  title: string;
  body: string;
  audience: "User" | "Admin" | "Both" | "Internal";
  status: "Captured" | "Needs Review" | "Approved" | "Published" | "Deprecated";
  featureIds: string[];
};

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
      type?: string;
      paragraph?: { rich_text?: Array<{ plain_text?: string }> };
      heading_2?: { rich_text?: Array<{ plain_text?: string }> };
    }>;
    has_more?: boolean;
    next_cursor?: string | null;
  };

  const lines: string[] = [];
  for (const block of response.results) {
    if (block.type === "paragraph") {
      const text = (block.paragraph?.rich_text ?? []).map((part) => part.plain_text ?? "").join("").trim();
      if (text) {
        lines.push(text);
      }
    }
  }

  return lines.join("\n");
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
    const featureIds = getRelationIds(properties, "Feature");
    const body = await loadEntryBody(input.notion, page.id);

    entries.push({
      pageId: page.id,
      title,
      body,
      audience: audience as PackableEntry["audience"],
      status: status as PackableEntry["status"],
      featureIds,
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

        let releasePageId = existingRelease.results[0]?.id;

        const sourceEntries: PackableEntry[] = input.entries
        ? input.entries.map((entry) => ({
            pageId: "",
            title: entry.title,
            body: entry.body,
            audience: entry.audience,
            status: entry.status,
            featureIds: [],
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

        const includedCount = sourceEntries.filter(
        (entry) =>
          (entry.status === "Published" || entry.status === "Approved") &&
          (input.audience === "both" ||
            (input.audience === "user" && (entry.audience === "User" || entry.audience === "Both")) ||
            (input.audience === "admin" && (entry.audience === "Admin" || entry.audience === "Both"))),
      ).length;
        const excludedCount = sourceEntries.length - includedCount;
        const excludedReasons = sourceEntries
          .filter(
            (entry) =>
              !(entry.status === "Published" || entry.status === "Approved") ||
              (input.audience === "user" && !(entry.audience === "User" || entry.audience === "Both")) ||
              (input.audience === "admin" && !(entry.audience === "Admin" || entry.audience === "Both")),
          )
          .map((entry) => ({
            entryTitle: entry.title,
            reason:
              !(entry.status === "Published" || entry.status === "Approved")
                ? `status=${entry.status}`
                : `audience_mismatch(${entry.audience})`,
          }));

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
            sourceEntries.flatMap((entry) => (entry.status === "Published" || entry.status === "Approved" ? entry.featureIds : [])),
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

        const updatedRelease = await withNotionRetry(() => notion.pages.update(updateReleasePayload), {
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

        const output = input.format === "markdown" ? markdown : releasePageUrl;

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
