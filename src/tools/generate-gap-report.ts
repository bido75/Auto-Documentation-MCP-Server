import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateGapReport } from "../lib/application-probe.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { getStateStore } from "../lib/state-store.js";

const evidenceSchema = z.object({
  file: z.string(),
  line: z.number(),
  snippet: z.string(),
});

const inventorySchema = z.object({
  schemaVersion: z.literal(1),
  repoPath: z.string(),
  generatedAt: z.string(),
  fileCount: z.number(),
  features: z.array(
    z.object({
      featureKey: z.string(),
      featureName: z.string(),
      kind: z.enum(["api_endpoint", "ui_component", "env_config", "package_script", "exported_symbol"]),
      summary: z.string(),
      files: z.array(z.string()),
      evidence: z.array(evidenceSchema),
      routes: z.array(z.string()),
      apiEndpoints: z.array(z.string()),
      envVars: z.array(z.string()),
      confidenceScore: z.number(),
    }),
  ),
});

export function registerGenerateGapReportTool(server: McpServer): void {
  server.tool(
    "generate_gap_report",
    "Compares a probe_application inventory with existing project documentation state and returns missing coverage gaps.",
    {
      projectId: z.string(),
      inventory: inventorySchema,
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "generate_gap_report",
        stage: "start",
        traceId,
        message: "Generating documentation gap report",
        data: { projectId: input.projectId, discoveredCount: input.inventory.features.length },
      });

      try {
        const project = await getStateStore().getProject(input.projectId);
        if (!project) {
          throw new Error("Unknown projectId. Run initialize_project_manual first.");
        }

        const gapReport = generateGapReport({ project, inventory: input.inventory });
        logToolEvent({
          level: "info",
          tool: "generate_gap_report",
          stage: "success",
          traceId,
          message: "Generated documentation gap report",
          data: {
            projectId: input.projectId,
            totalDiscovered: gapReport.totalDiscovered,
            missingCount: gapReport.missingCount,
            durationMs: Date.now() - startedAt,
          },
        });

        return { content: [{ type: "text", text: JSON.stringify({ traceId, gapReport }, null, 2) }] };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "generate_gap_report",
          stage: "failure",
          traceId,
          message: "Failed to generate documentation gap report",
          data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({ tool: "generate_gap_report", traceId, error, defaultCode: "GENERATE_GAP_REPORT_FAILED" });
      }
    },
  );
}

export { inventorySchema };

