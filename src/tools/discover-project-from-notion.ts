import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { createNotionClient } from "../lib/notion-client.js";
import { getStateStore } from "../lib/state-store.js";
import { selfInitializeProjectFromNotion, type NotionDiscoveryClient } from "../notion/discovery.js";

export function registerDiscoverProjectFromNotionTool(server: McpServer) {
  server.tool(
    "discover_project_from_notion",
    "Discover and validate an existing Auto-Doc Notion project binding, then initialize local state when safe.",
    {
      projectPageId: z.string(),
      traceId: z.string().optional(),
    },
    async ({ projectPageId, traceId }) => {
      const resolvedTraceId = resolveTraceId(traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "discover_project_from_notion",
        stage: "start",
        traceId: resolvedTraceId,
        message: "Starting explicit Notion project discovery.",
        data: { projectPageId },
      });

      const result = await selfInitializeProjectFromNotion({
        notion: createNotionClient() as unknown as NotionDiscoveryClient,
        store: getStateStore(),
        projectPageId,
        traceId: resolvedTraceId,
      });

      logToolEvent({
        level: result.ok ? "info" : "error",
        tool: "discover_project_from_notion",
        stage: result.ok ? "success" : "refused",
        traceId: resolvedTraceId,
        message: result.ok ? "Notion project discovery completed." : "Notion project discovery refused to bind.",
        data: {
          projectPageId,
          durationMs: Date.now() - startedAt,
          status: result.ok ? result.status : undefined,
          reasonCode: result.ok ? undefined : result.reasonCode,
        },
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ ...result, traceId: resolvedTraceId }, null, 2) }],
      };
    },
  );
}
