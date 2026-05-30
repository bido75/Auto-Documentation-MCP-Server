import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { logToolEvent, resolveTraceId } from "../lib/logger.js";
import { throwAsMcpToolError } from "../lib/mcp-error.js";
import { registerExportManualPdfTool } from "./export-manual-pdf.js";
import { registerExportHelpCenterContentTool } from "./export-help-center-content.js";
import { registerGenerateReleaseChangelogTool } from "./generate-release-changelog.js";
import { registerPackageManualTool } from "./package-manual.js";
import { registerPublishPrCommentTool } from "./publish-pr-comment.js";
import { registerRunAutonomousDocumentationTriggerTool } from "./run-autonomous-documentation-trigger.js";
import { registerSyncManualToLocalDocsTool } from "./sync-manual-to-local-docs.js";

type ToolCallResult = {
  content: Array<{ type: string; text: string }>;
};

type ToolHandler = (input: unknown) => Promise<ToolCallResult>;

class InMemoryToolHost {
  public readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

function parseToolText<T>(result: ToolCallResult): T {
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("Tool did not return a text payload.");
  }

  return JSON.parse(first.text) as T;
}

function defaultPdfPath(releaseVersion: string): string {
  return `artifacts/manual-${releaseVersion}.pdf`;
}

export function registerRunReleaseDocumentationPipelineTool(server: McpServer) {
  server.tool(
    "run_release_documentation_pipeline",
    "Runs release-tag documentation automation: capture, changelog, package, PDF export, local sync, and optional PR comment posting.",
    {
      projectId: z.string(),
      releaseVersion: z.string().min(1),
      repoPath: z.string().optional(),
      mode: z.enum(["staged", "last_commit", "working_tree"]).default("last_commit"),
      prUrl: z.string().url().optional(),
      audience: z.enum(["user", "admin", "both"]).default("both"),
      packageFormat: z.enum(["notion_page", "markdown"]).default("notion_page"),
      pdfOutputPath: z.string().optional(),
      localDocsOutputPath: z.string().default("docs/MANUAL.md"),
      helpCenterOutputPath: z.string().optional(),
      traceId: z.string().optional(),
    },
    async ({
      projectId,
      releaseVersion,
      repoPath,
      mode,
      prUrl,
      audience,
      packageFormat,
      pdfOutputPath,
      localDocsOutputPath,
      helpCenterOutputPath,
      traceId: incomingTraceId,
    }) => {
      const traceId = resolveTraceId(incomingTraceId);
      const startedAt = Date.now();

      logToolEvent({
        level: "info",
        tool: "run_release_documentation_pipeline",
        stage: "start",
        traceId,
        message: "Running release documentation pipeline",
        data: { projectId, releaseVersion, mode, audience, packageFormat, prUrl: prUrl ?? null },
      });

      try {
        const host = new InMemoryToolHost();
        registerRunAutonomousDocumentationTriggerTool(host as unknown as McpServer);
        registerGenerateReleaseChangelogTool(host as unknown as McpServer);
        registerPackageManualTool(host as unknown as McpServer);
        registerExportManualPdfTool(host as unknown as McpServer);
        registerSyncManualToLocalDocsTool(host as unknown as McpServer);
        registerExportHelpCenterContentTool(host as unknown as McpServer);
        registerPublishPrCommentTool(host as unknown as McpServer);

        const runTrigger = host.handlers.get("run_autonomous_documentation_trigger");
        const generateChangelog = host.handlers.get("generate_release_changelog");
        const packageManual = host.handlers.get("package_manual");
        const exportPdf = host.handlers.get("export_manual_pdf");
        const syncLocalDocs = host.handlers.get("sync_manual_to_local_docs");
        const exportHelpCenter = host.handlers.get("export_help_center_content");
        const publishPrComment = host.handlers.get("publish_pr_comment");

        if (!runTrigger || !generateChangelog || !packageManual || !exportPdf || !syncLocalDocs || !exportHelpCenter || !publishPrComment) {
          throw new Error("Release pipeline could not resolve required tool handlers.");
        }

        const triggerResult = parseToolText<Record<string, unknown>>(
          await runTrigger({
            projectId,
            repoPath,
            mode,
            source: "release",
            eventType: "release_tagged",
            summary: `Release tagged: ${releaseVersion}`,
            releaseVersion,
            traceId,
          }),
        );

        const changelogResult = parseToolText<Record<string, unknown>>(
          await generateChangelog({
            projectId,
            releaseVersion,
            traceId,
          }),
        );

        const packageResult = parseToolText<Record<string, unknown>>(
          await packageManual({
            projectId,
            releaseVersion,
            audience,
            format: packageFormat,
            traceId,
          }),
        );

        const resolvedPdfOutputPath = pdfOutputPath && pdfOutputPath.length > 0 ? pdfOutputPath : defaultPdfPath(releaseVersion);

        const pdfResult = parseToolText<Record<string, unknown>>(
          await exportPdf({
            projectId,
            releaseVersion,
            audience,
            outputPath: resolvedPdfOutputPath,
            traceId,
          }),
        );

        const syncResult = parseToolText<Record<string, unknown>>(
          await syncLocalDocs({
            projectId,
            audience,
            releaseVersion,
            outputPath: localDocsOutputPath,
            traceId,
          }),
        );

        const helpCenterResult = helpCenterOutputPath
          ? parseToolText<Record<string, unknown>>(
              await exportHelpCenter({
                projectId,
                audience,
                releaseVersion,
                outputPath: helpCenterOutputPath,
                traceId,
              }),
            )
          : null;

        const prCommentResult = prUrl
          ? parseToolText<Record<string, unknown>>(
              await publishPrComment({
                projectId,
                prUrl,
                audience,
                traceId,
              }),
            )
          : null;

        logToolEvent({
          level: "info",
          tool: "run_release_documentation_pipeline",
          stage: "success",
          traceId,
          message: "Completed release documentation pipeline",
          data: {
            projectId,
            releaseVersion,
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
                  projectId,
                  releaseVersion,
                  trigger: triggerResult,
                  changelog: changelogResult,
                  package: packageResult,
                  pdf: pdfResult,
                  sync: syncResult,
                  helpCenter: helpCenterResult,
                  prComment: prCommentResult,
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
          tool: "run_release_documentation_pipeline",
          stage: "failure",
          traceId,
          message: "Failed release documentation pipeline",
          data: { projectId, releaseVersion, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt },
        });

        throwAsMcpToolError({
          tool: "run_release_documentation_pipeline",
          traceId,
          error,
          defaultCode: "RUN_RELEASE_DOCUMENTATION_PIPELINE_FAILED",
        });
      }
    },
  );
}
