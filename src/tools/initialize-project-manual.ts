import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRuntimeConfig } from "../config.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { createNotionClient } from "../lib/notion-client.js";
import { runInitializePreflight } from "../lib/notion-preflight.js";
import { getStateStore } from "../lib/state-store.js";
import { initializeProjectManual } from "../notion/project-manual.js";

function normalizePublishingMode(mode?: "conservative" | "balanced" | "fully_automatic") {
  if (mode === "conservative") {
    return "Conservative" as const;
  }

  if (mode === "fully_automatic") {
    return "Fully Automatic" as const;
  }

  return "Balanced" as const;
}

export function registerInitializeProjectManualTool(server: McpServer) {
  server.tool(
    "initialize_project_manual",
    "Create the Notion databases for an auto-generated project manual.",
    {
      projectName: z.string(),
      parentPageId: z.string(),
      repositoryUrl: z.string().url().optional(),
      publishingMode: z.enum(["conservative", "balanced", "fully_automatic"]).optional(),
      autoPublishThreshold: z.number().min(0).max(100).optional(),
      traceId: z.string().optional(),
    },
    async ({ projectName, parentPageId, repositoryUrl, publishingMode, autoPublishThreshold, traceId }) => {
      const resolvedTraceId = resolveTraceId(traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "initialize_project_manual",
        stage: "start",
        traceId: resolvedTraceId,
        message: "Initializing project manual schema",
        data: { projectName },
      });

      const config = getRuntimeConfig();
      const notion = createNotionClient();
      try {
        await runInitializePreflight({ notion, parentPageId });

        const result = await initializeProjectManual({
          notion,
          store: getStateStore(),
          projectName,
          parentPageId,
          repositoryUrl,
          publishingMode: normalizePublishingMode(publishingMode) ?? config.defaultPublishingMode,
          autoPublishThreshold: autoPublishThreshold ?? config.defaultAutoPublishThreshold,
        });

        logToolEvent({
          level: "info",
          tool: "initialize_project_manual",
          stage: "success",
          traceId: resolvedTraceId,
          message: "Initialized project manual schema",
          data: { projectId: result.projectId, durationMs: Date.now() - startedAt },
        });

        return {
          content: [{ type: "text", text: JSON.stringify({ ...result, traceId: resolvedTraceId }, null, 2) }],
        };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "initialize_project_manual",
          stage: "failure",
          traceId: resolvedTraceId,
          message: "Failed to initialize project manual schema",
          data: { error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({
          tool: "initialize_project_manual",
          traceId: resolvedTraceId,
          error,
          defaultCode: "INITIALIZE_PROJECT_MANUAL_FAILED",
        });
      }
    },
  );
}
