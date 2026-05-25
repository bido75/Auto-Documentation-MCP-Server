import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createNotionClient } from "../lib/notion-client.js";
import { runProjectPreflight } from "../lib/notion-preflight.js";
import { withNotionRetry } from "../lib/notion-retry.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { getStateStore } from "../lib/state-store.js";
import { createManualEntry } from "../notion/manual-entry.js";

function normalizePublishingMode(mode: "conservative" | "balanced" | "fully_automatic") {
  if (mode === "conservative") {
    return "Conservative" as const;
  }

  if (mode === "fully_automatic") {
    return "Fully Automatic" as const;
  }

  return "Balanced" as const;
}

export function registerUpsertFeatureDocumentationTool(server: McpServer) {
  server.tool(
    "upsert_feature_documentation",
    "Creates or updates Notion feature and manual entry pages.",
    {
      projectId: z.string(),
      featureKey: z.string(),
      featureName: z.string(),
      module: z.string().optional(),
      audiences: z.array(z.enum(["User", "Admin", "Developer", "Support"])),
      manualEntriesDatabaseId: z.string().optional(),
      manualEntries: z.array(
        z.object({
          entryType: z.enum(["User Guide", "Admin Guide", "Developer Note", "Release Note"]),
          title: z.string(),
          userGuide: z.string(),
          adminGuide: z.string(),
          developerNotes: z.string().optional(),
          routes: z.array(z.string()).optional(),
          apiEndpoints: z.array(z.string()).optional(),
        }),
      ),
      evidenceEventIds: z.array(z.string()),
      confidenceScore: z.number().min(0).max(100),
      confidenceReasons: z.array(z.string()),
      publishingMode: z.enum(["conservative", "balanced", "fully_automatic"]),
      autoPublishThreshold: z.number().min(0).max(100),
      sourceCommit: z.string().optional(),
      sourcePr: z.string().url().optional(),
      filesChanged: z.array(z.string()).optional(),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "upsert_feature_documentation",
        stage: "start",
        traceId,
        message: "Upserting feature documentation",
        data: { projectId: input.projectId, featureKey: input.featureKey, manualEntries: input.manualEntries.length },
      });

      try {
        const notion = createNotionClient();
        const store = getStateStore();
        const project = await store.getProject(input.projectId);
        if (!project) {
          throw new Error("Unknown projectId. Run initialize_project_manual first.");
        }

        await runProjectPreflight({ notion, project });

        const manualEntriesDatabaseId = input.manualEntriesDatabaseId ?? project.databases.manualEntriesDatabaseId;

        const { decidePublishingStatus } = await import("../notion/manual-entry.js");
        const publish = decidePublishingStatus({
          mode: normalizePublishingMode(input.publishingMode),
          score: input.confidenceScore,
          threshold: input.autoPublishThreshold,
        });

        let featurePageId = await store.getFeature(input.projectId, input.featureKey);

        if (!featurePageId) {
        const queryPayload = {
          database_id: project.databases.featuresDatabaseId,
          filter: {
            property: "Feature Key",
            rich_text: { equals: input.featureKey },
          },
          page_size: 1,
        };

          const query = await withNotionRetry(() => notion.databases.query(queryPayload), {
            operationName: "databases.query",
            payload: queryPayload,
          });

          if (query.results.length > 0) {
            featurePageId = query.results[0].id;
          }
        }

        const eventRelationIds: Array<{ id: string }> = [];
        for (const eventId of input.evidenceEventIds) {
          const pageId = await store.getEvent(input.projectId, eventId);
          if (pageId) {
            eventRelationIds.push({ id: pageId });
          }
        }

        if (!featurePageId) {
        const createFeaturePayload = {
          parent: { database_id: project.databases.featuresDatabaseId },
          properties: {
            "Feature Name": { title: [{ text: { content: input.featureName } }] },
            "Feature Key": { rich_text: [{ text: { content: input.featureKey } }] },
            ...(input.module ? { Module: { select: { name: input.module } } } : {}),
            "Audience Impact": { multi_select: input.audiences.map((name) => ({ name })) },
            Status: { status: { name: publish.status } },
            "Confidence Score": { number: input.confidenceScore },
            ...(input.sourceCommit
              ? { "First Seen Commit": { rich_text: [{ text: { content: input.sourceCommit } }] } }
              : {}),
            ...(input.sourceCommit
              ? { "Last Documented Commit": { rich_text: [{ text: { content: input.sourceCommit } }] } }
              : {}),
            Project: { relation: [{ id: project.projectPageId ?? project.projectId }] },
            ...(eventRelationIds.length > 0 ? { "Evidence Events": { relation: eventRelationIds } } : {}),
          },
        };

          const createdFeature = await withNotionRetry(() => notion.pages.create(createFeaturePayload), {
            operationName: "pages.create",
            payload: createFeaturePayload,
          });

          featurePageId = createdFeature.id;
        }

        if (!featurePageId) {
          throw new Error("Failed to resolve feature page ID after upsert.");
        }

      const updateFeaturePayload = {
        page_id: featurePageId,
        properties: {
          "Feature Name": { title: [{ text: { content: input.featureName } }] },
          ...(input.module ? { Module: { select: { name: input.module } } } : {}),
          "Audience Impact": { multi_select: input.audiences.map((name) => ({ name })) },
          Status: { status: { name: publish.status } },
          "Confidence Score": { number: input.confidenceScore },
          ...(input.sourceCommit
            ? { "Last Documented Commit": { rich_text: [{ text: { content: input.sourceCommit } }] } }
            : {}),
          ...(eventRelationIds.length > 0 ? { "Evidence Events": { relation: eventRelationIds } } : {}),
        },
      };

        await withNotionRetry(() => notion.pages.update(updateFeaturePayload), {
          operationName: "pages.update",
          payload: updateFeaturePayload,
        });

        await store.setFeature(input.projectId, input.featureKey, featurePageId);

        const pages = [];
        for (const entry of input.manualEntries) {
          const body =
            entry.entryType === "User Guide"
              ? entry.userGuide
              : entry.entryType === "Admin Guide"
                ? entry.adminGuide
                : entry.developerNotes ?? entry.userGuide;

          pages.push(
            await createManualEntry({
              notion,
              databaseId: manualEntriesDatabaseId,
              draft: {
                entryTitle: entry.title,
                entryType: entry.entryType,
                audience: entry.entryType === "User Guide" ? "User" : entry.entryType === "Admin Guide" ? "Admin" : "Internal",
                body,
                routes: entry.routes,
                apiEndpoints: entry.apiEndpoints,
              },
              status: publish.status,
              decision: publish.decision,
              confidenceScore: input.confidenceScore,
              sourceCommit: input.sourceCommit,
              sourcePr: input.sourcePr,
              filesChanged: input.filesChanged,
              projectPageId: project.projectPageId ?? project.projectId,
              featurePageId,
            }),
          );
        }

        logToolEvent({
          level: "info",
          tool: "upsert_feature_documentation",
          stage: "success",
          traceId,
          message: "Upserted feature documentation",
          data: {
            projectId: input.projectId,
            featureId: featurePageId,
            manualEntryCount: pages.length,
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
                  featureId: featurePageId,
                  featureName: input.featureName,
                  featureKey: input.featureKey,
                  evidenceEventIds: input.evidenceEventIds,
                  publishing: publish,
                  manualEntries: pages,
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
          tool: "upsert_feature_documentation",
          stage: "failure",
          traceId,
          message: "Failed to upsert feature documentation",
          data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "upsert_feature_documentation",
          traceId,
          error,
          defaultCode: "UPSERT_FEATURE_DOCUMENTATION_FAILED",
        });
      }
    },
  );
}
