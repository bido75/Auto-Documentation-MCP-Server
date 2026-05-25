import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyzeDocumentationCandidateTool } from "./tools/analyze-documentation-candidate.js";
import { registerCaptureDevelopmentEventTool } from "./tools/capture-development-event.js";
import { registerCaptureFeatureScreenshotTool } from "./tools/capture-feature-screenshot.js";
import { registerExportManualMarkdownTool } from "./tools/export-manual-markdown.js";
import { registerGetDocumentationStatusTool } from "./tools/get-documentation-status.js";
import { registerGetGitDiffSummaryTool } from "./tools/get-git-diff-summary.js";
import { registerInitializeProjectManualTool } from "./tools/initialize-project-manual.js";
import { registerPackageManualTool } from "./tools/package-manual.js";
import { registerPublishOrQueueReviewTool } from "./tools/publish-or-queue-review.js";
import { registerUpsertFeatureDocumentationTool } from "./tools/upsert-feature-documentation.js";

export function createServer() {
  const server = new McpServer({
    name: "auto-docs-notion-mcp",
    version: "0.1.0",
  });

  registerInitializeProjectManualTool(server);
  registerCaptureDevelopmentEventTool(server);
  registerAnalyzeDocumentationCandidateTool(server);
  registerUpsertFeatureDocumentationTool(server);
  registerPublishOrQueueReviewTool(server);
  registerPackageManualTool(server);
  registerGetDocumentationStatusTool(server);
  registerGetGitDiffSummaryTool(server);
  registerCaptureFeatureScreenshotTool(server);
  registerExportManualMarkdownTool(server);

  return server;
}
