import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateGapReport, type DocumentationGap, type GapReport } from "../lib/application-probe.js";
import { authorManualSection } from "../lib/manual-author.js";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { getStateStore } from "../lib/state-store.js";
import { registerCaptureDevelopmentEventTool } from "./capture-development-event.js";
import { inventorySchema } from "./generate-gap-report.js";
import { registerUpsertFeatureDocumentationTool } from "./upsert-feature-documentation.js";
import type { Audience } from "../types.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;

class ToolHost {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler): void {
    this.handlers.set(name, handler);
  }
}

const gapSchema = z.object({
  featureKey: z.string(),
  featureName: z.string(),
  kind: z.enum(["api_endpoint", "ui_component", "env_config", "package_script", "exported_symbol"]),
  status: z.enum(["missing", "documented"]),
  reason: z.string(),
  files: z.array(z.string()),
  routes: z.array(z.string()),
  apiEndpoints: z.array(z.string()),
  envVars: z.array(z.string()),
  evidence: z.array(z.object({ file: z.string(), line: z.number(), snippet: z.string() })),
  confidenceScore: z.number(),
});

const gapReportSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string(),
  generatedAt: z.string(),
  totalDiscovered: z.number(),
  documentedCount: z.number(),
  missingCount: z.number(),
  gaps: z.array(gapSchema),
});

function parseTool<T>(result: ToolResult): T {
  return JSON.parse(result.content[0]?.text ?? "{}") as T;
}

function summarizeGap(gap: DocumentationGap): string {
  const evidence = gap.evidence.map((item) => `${item.file}:${item.line} ${item.snippet}`).join("\n");
  const routeText = gap.apiEndpoints.length > 0 ? `\nAPI endpoints: ${gap.apiEndpoints.join(", ")}` : "";
  const envText = gap.envVars.length > 0 ? `\nEnvironment variables: ${gap.envVars.join(", ")}` : "";
  return `${gap.reason}\nKind: ${gap.kind}${routeText}${envText}\nEvidence:\n${evidence}`;
}

function audienceList(gap: DocumentationGap): Audience[] {
  if (gap.kind === "env_config" || gap.kind === "package_script" || gap.kind === "api_endpoint") {
    return ["User", "Admin"];
  }
  return ["User"];
}

async function synthesizeOne(input: {
  projectId: string;
  repoPath?: string;
  gap: DocumentationGap;
  publishingMode: "conservative" | "balanced" | "fully_automatic";
  autoPublishThreshold: number;
  traceId: string;
}): Promise<{ featureKey: string; evidenceEventId: string; manualEntryCount: number; featureId: string }> {
  const host = new ToolHost();
  registerCaptureDevelopmentEventTool(host as unknown as McpServer);
  registerUpsertFeatureDocumentationTool(host as unknown as McpServer);

  const capture = host.handlers.get("capture_development_event");
  const upsert = host.handlers.get("upsert_feature_documentation");
  if (!capture || !upsert) {
    throw new Error("Failed to initialize synthesis tool chain.");
  }

  const summary = `Retrospective probe found undocumented feature: ${input.gap.featureName}`;
  const diffSummary = summarizeGap(input.gap);
  const captureResult = parseTool<{ evidenceEventId: string }>(
    await capture({
      projectId: input.projectId,
      source: "ai_session",
      eventType: "session_completed",
      summary,
      diffSummary,
      filesChanged: input.gap.files.join(", "),
      testStatus: "unknown",
      externalEventId: `probe:${input.projectId}:${input.gap.featureKey}`,
      traceId: input.traceId,
    }),
  );

  const audiences = audienceList(input.gap);
  const userSection = await authorManualSection({
    audience: "User",
    entryType: "User Guide",
    featureName: input.gap.featureName,
    summary,
    diffSummary,
    filesChanged: input.gap.files,
    repoPath: input.repoPath,
  });
  const adminSection = audiences.includes("Admin")
    ? await authorManualSection({
        audience: "Admin",
        entryType: "Admin Guide",
        featureName: input.gap.featureName,
        summary,
        diffSummary,
        filesChanged: input.gap.files,
        repoPath: input.repoPath,
      })
    : null;

  const manualEntries = [
    {
      entryType: "User Guide" as const,
      title: `${input.gap.featureName} User Guide`,
      userGuide: userSection.body,
      adminGuide: adminSection?.body ?? "",
      routes: input.gap.routes,
      apiEndpoints: input.gap.apiEndpoints,
    },
    ...(adminSection
      ? [
          {
            entryType: "Admin Guide" as const,
            title: `${input.gap.featureName} Admin Guide`,
            userGuide: userSection.body,
            adminGuide: adminSection.body,
            routes: input.gap.routes,
            apiEndpoints: input.gap.apiEndpoints,
          },
        ]
      : []),
  ];

  const upsertResult = parseTool<{ featureId: string; manualEntries: Array<{ pageId: string }> }>(
    await upsert({
      projectId: input.projectId,
      featureKey: input.gap.featureKey,
      featureName: input.gap.featureName,
      module: input.gap.kind,
      audiences: audiences.map((audience) => (audience === "User" || audience === "Admin" ? audience : "Developer")),
      manualEntries,
      evidenceEventIds: [captureResult.evidenceEventId],
      confidenceScore: Math.max(60, Math.min(92, input.gap.confidenceScore)),
      confidenceReasons: ["Generated from retrospective codebase probe evidence.", ...input.gap.evidence.slice(0, 3).map((item) => `${item.file}:${item.line}`)],
      publishingMode: input.publishingMode,
      autoPublishThreshold: input.autoPublishThreshold,
      filesChanged: input.gap.files,
      traceId: input.traceId,
    }),
  );

  return {
    featureKey: input.gap.featureKey,
    evidenceEventId: captureResult.evidenceEventId,
    manualEntryCount: upsertResult.manualEntries.length,
    featureId: upsertResult.featureId,
  };
}

export function registerSynthesizeMissingContentTool(server: McpServer): void {
  server.tool(
    "synthesize_missing_content",
    "Generates grounded manual entries for missing features from a gap report and upserts them through the standard Notion flow.",
    {
      projectId: z.string(),
      repoPath: z.string().optional(),
      inventory: inventorySchema.optional(),
      gapReport: gapReportSchema.optional(),
      maxFeatures: z.number().int().min(1).max(50).optional(),
      publishingMode: z.enum(["conservative", "balanced", "fully_automatic"]).optional(),
      autoPublishThreshold: z.number().min(0).max(100).optional(),
      traceId: z.string().optional(),
    },
    async (input) => {
      const traceId = resolveTraceId(input.traceId);
      const startedAt = Date.now();
      logToolEvent({
        level: "info",
        tool: "synthesize_missing_content",
        stage: "start",
        traceId,
        message: "Synthesizing missing documentation from retrospective gaps",
        data: { projectId: input.projectId },
      });

      try {
        const project = await getStateStore().getProject(input.projectId);
        if (!project) {
          throw new Error("Unknown projectId. Run initialize_project_manual first.");
        }
        const report: GapReport = input.gapReport ?? generateGapReport({ project, inventory: input.inventory ?? { schemaVersion: 1, repoPath: input.repoPath ?? "", generatedAt: new Date().toISOString(), fileCount: 0, features: [] } });
        const missing = report.gaps.filter((gap) => gap.status === "missing").slice(0, input.maxFeatures ?? 10);
        const results = [];
        for (const gap of missing) {
          results.push(
            await synthesizeOne({
              projectId: input.projectId,
              repoPath: input.repoPath,
              gap,
              publishingMode: input.publishingMode ?? "balanced",
              autoPublishThreshold: input.autoPublishThreshold ?? project.autoPublishThreshold,
              traceId,
            }),
          );
        }

        logToolEvent({
          level: "info",
          tool: "synthesize_missing_content",
          stage: "success",
          traceId,
          message: "Synthesized missing documentation",
          data: { projectId: input.projectId, synthesizedCount: results.length, durationMs: Date.now() - startedAt },
        });

        return { content: [{ type: "text", text: JSON.stringify({ traceId, synthesizedCount: results.length, results }, null, 2) }] };
      } catch (error) {
        logToolEvent({
          level: "error",
          tool: "synthesize_missing_content",
          stage: "failure",
          traceId,
          message: "Failed to synthesize missing documentation",
          data: { projectId: input.projectId, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });
        throwAsMcpToolError({ tool: "synthesize_missing_content", traceId, error, defaultCode: "SYNTHESIZE_MISSING_CONTENT_FAILED" });
      }
    },
  );
}
