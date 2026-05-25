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

function getStatusName(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key] as { status?: { name?: string } } | undefined;
  return value?.status?.name ?? null;
}

function getNumberValue(properties: Record<string, unknown>, key: string): number | null {
  const value = properties[key] as { number?: number | null } | undefined;
  return typeof value?.number === "number" ? value.number : null;
}

function getTitleValue(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key] as { title?: Array<{ text?: { content?: string } }> } | undefined;
  return value?.title?.[0]?.text?.content ?? null;
}

function getRichTextValue(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key] as { rich_text?: Array<{ text?: { content?: string } }> } | undefined;
  return value?.rich_text?.[0]?.text?.content ?? null;
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

export function registerGetDocumentationStatusTool(server: McpServer) {
  server.tool(
    "get_documentation_status",
    "Reports documentation health for a project.",
    {
      projectId: z.string(),
      releaseVersion: z.string().optional(),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "get_documentation_status",
        stage: "start",
        traceId,
        message: "Computing documentation status",
        data: { projectId: input.projectId, releaseVersion: input.releaseVersion ?? null },
      });

      try {
        const store = getStateStore();
        const notion = createNotionClient();
        const project = await store.getProject(input.projectId);
        if (!project) {
          throw new Error("Unknown projectId. Run initialize_project_manual first.");
        }

        await runProjectPreflight({ notion, project });

        let releasePageId: string | undefined;
        if (input.releaseVersion) {
          const releases = await queryAll(notion, {
            database_id: project.databases.releasesDatabaseId,
            filter: {
              and: [
                {
                  property: "Project",
                  relation: { contains: project.projectPageId ?? project.projectId },
                },
                {
                  property: "Release Version",
                  title: { equals: input.releaseVersion },
                },
              ],
            },
            page_size: 100,
          });

          releasePageId = releases[0]?.id;
        }

        const filterClauses: Array<Record<string, unknown>> = [
          {
            property: "Project",
            relation: { contains: project.projectPageId ?? project.projectId },
          },
        ];

        if (releasePageId) {
          filterClauses.push({
            property: "Release",
            relation: { contains: releasePageId },
          });
        }

        const entries = await queryAll(notion, {
          database_id: project.databases.manualEntriesDatabaseId,
          filter: { and: filterClauses },
          page_size: 100,
        });

        const stats = {
          publishedCount: 0,
          needsReviewCount: 0,
          capturedCount: 0,
          lowConfidenceCount: 0,
          missingReviewQuestions: [] as string[],
        };

        for (const entry of entries) {
          const properties = entry.properties ?? {};
          const status = getStatusName(properties, "Status");
          const confidence = getNumberValue(properties, "Confidence Score");
          const reviewNotes = getRichTextValue(properties, "Reviewer Notes");
          const title = getTitleValue(properties, "Entry Title") ?? `Entry ${entry.id}`;

          if (status === "Published") {
            stats.publishedCount += 1;
          } else if (status === "Needs Review") {
            stats.needsReviewCount += 1;
            if (!reviewNotes) {
              stats.missingReviewQuestions.push(`Missing reviewer notes for '${title}'.`);
            }
          } else if (status === "Captured") {
            stats.capturedCount += 1;
          }

          if (typeof confidence === "number" && confidence < 60) {
            stats.lowConfidenceCount += 1;
          }
        }

        const health =
          stats.needsReviewCount > 0 || stats.lowConfidenceCount > 0
            ? "Needs Review"
            : stats.capturedCount > stats.publishedCount
              ? "Behind"
              : "Healthy";

        logToolEvent({
          level: "info",
          tool: "get_documentation_status",
          stage: "success",
          traceId,
          message: "Computed documentation status",
          data: {
            projectId: input.projectId,
            health,
            publishedCount: stats.publishedCount,
            needsReviewCount: stats.needsReviewCount,
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
                  projectId: input.projectId,
                  releaseVersion: input.releaseVersion ?? null,
                  publishedCount: stats.publishedCount,
                  needsReviewCount: stats.needsReviewCount,
                  capturedCount: stats.capturedCount,
                  lowConfidenceCount: stats.lowConfidenceCount,
                  missingReviewQuestions: stats.missingReviewQuestions,
                  health,
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
          tool: "get_documentation_status",
          stage: "failure",
          traceId,
          message: "Failed to compute documentation status",
          data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "get_documentation_status",
          traceId,
          error,
          defaultCode: "DOCUMENTATION_STATUS_FAILED",
        });
      }
    },
  );
}
