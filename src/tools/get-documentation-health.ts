import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { createNotionClient } from "../lib/notion-client.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { getStateStore } from "../lib/state-store.js";

type NotionPage = {
  id: string;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
};

type NotionQueryResult = {
  results: NotionPage[];
  has_more?: boolean;
  next_cursor?: string | null;
};

function getStatusName(properties: Record<string, unknown>, key: string): string | null {
  return (properties[key] as { status?: { name?: string } } | undefined)?.status?.name ?? null;
}

function getSelectName(properties: Record<string, unknown>, key: string): string | null {
  return (properties[key] as { select?: { name?: string } } | undefined)?.select?.name ?? null;
}

function getNumberValue(properties: Record<string, unknown>, key: string): number | null {
  const value = (properties[key] as { number?: number | null } | undefined)?.number;
  return typeof value === "number" ? value : null;
}

function getTitleValue(properties: Record<string, unknown>, key: string): string | null {
  const title = (properties[key] as { title?: Array<{ plain_text?: string; text?: { content?: string } }> } | undefined)?.title ?? [];
  return title[0]?.plain_text ?? title[0]?.text?.content ?? null;
}

function getRelationIds(properties: Record<string, unknown>, key: string): string[] {
  const relation = (properties[key] as { relation?: Array<{ id?: string }> } | undefined)?.relation ?? [];
  return relation.map((item) => item.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

function gradeForCoverage(coverage: number): "A" | "B" | "C" | "D" | "F" {
  if (coverage >= 90) return "A";
  if (coverage >= 75) return "B";
  if (coverage >= 50) return "C";
  if (coverage >= 25) return "D";
  return "F";
}

async function queryAll(notion: ReturnType<typeof createNotionClient>, input: Record<string, unknown>): Promise<NotionPage[]> {
  const results: NotionPage[] = [];
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

export function registerGetDocumentationHealthTool(server: McpServer) {
  server.tool(
    "get_documentation_health",
    "Returns documentation coverage, grade, status breakdown, audience coverage, confidence, and stale-entry warnings for a project.",
    {
      projectId: z.string(),
      staleAfterDays: z.number().int().min(1).max(365).default(30),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "get_documentation_health",
        stage: "start",
        traceId,
        message: "Computing documentation health score",
        data: { projectId: input.projectId, staleAfterDays: input.staleAfterDays },
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

        const [features, entries] = await Promise.all([
          queryAll(notion, {
            database_id: project.databases.featuresDatabaseId,
            filter: { property: "Project", relation: { contains: projectPageId } },
            page_size: 100,
          }),
          queryAll(notion, {
            database_id: project.databases.manualEntriesDatabaseId,
            filter: { property: "Project", relation: { contains: projectPageId } },
            page_size: 100,
          }),
        ]);

        const documentedFeatureIds = new Set<string>();
        const byStatus: Record<string, number> = {};
        const byAudience: Record<string, number> = {};
        const staleEntries: string[] = [];
        const staleMs = input.staleAfterDays * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let confidenceSum = 0;
        let confidenceCount = 0;

        for (const entry of entries) {
          const properties = entry.properties ?? {};
          const status = getStatusName(properties, "Status") ?? "Unknown";
          const audience = getSelectName(properties, "Audience") ?? "Unknown";
          byStatus[status] = (byStatus[status] ?? 0) + 1;
          byAudience[audience] = (byAudience[audience] ?? 0) + 1;

          for (const featureId of getRelationIds(properties, "Feature")) {
            documentedFeatureIds.add(featureId);
          }

          const confidence = getNumberValue(properties, "Confidence Score");
          if (typeof confidence === "number") {
            confidenceSum += confidence;
            confidenceCount += 1;
          }

          if (entry.last_edited_time && now - new Date(entry.last_edited_time).getTime() > staleMs) {
            staleEntries.push(getTitleValue(properties, "Entry Title") ?? `Entry ${entry.id}`);
          }
        }

        const totalFeatures = features.length;
        const documentedFeatures = documentedFeatureIds.size;
        const coverage = totalFeatures > 0 ? Math.round((documentedFeatures / totalFeatures) * 100) : 0;
        const grade = gradeForCoverage(coverage);
        const averageConfidence = confidenceCount > 0 ? Math.round(confidenceSum / confidenceCount) : 0;

        const health =
          coverage >= 90 && (byStatus["Needs Review"] ?? 0) === 0
            ? "Healthy"
            : coverage >= 75
              ? "Watch"
              : "Needs Attention";

        const response = {
          traceId,
          projectId: input.projectId,
          projectName: project.projectName,
          generatedAt: new Date().toISOString(),
          health,
          coverage,
          grade,
          totalFeatures,
          documentedFeatures,
          undocumentedFeatures: Math.max(0, totalFeatures - documentedFeatures),
          entries: {
            total: entries.length,
            byStatus,
            byAudience,
            averageConfidence,
            staleAfterDays: input.staleAfterDays,
            staleCount: staleEntries.length,
            staleEntries: staleEntries.slice(0, 10),
          },
          actions: {
            reviewQueue: byStatus["Needs Review"] ?? 0,
            runGapReportRecommended: coverage < 80,
            staleRefreshRecommended: staleEntries.length > 0,
          },
        };

        logToolEvent({
          level: "info",
          tool: "get_documentation_health",
          stage: "success",
          traceId,
          message: "Computed documentation health score",
          data: { projectId: input.projectId, coverage, grade, durationMs: Date.now() - startedAt },
        });

        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "get_documentation_health",
          stage: "failure",
          traceId,
          message: "Failed to compute documentation health score",
          data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "get_documentation_health",
          traceId,
          error,
          defaultCode: "DOCUMENTATION_HEALTH_FAILED",
        });
      }
    },
  );
}
