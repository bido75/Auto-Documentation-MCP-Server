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
import { registerExtraTools } from "./tools/extra-tools.js";
import { registerUpsertFeatureDocumentationTool } from "./tools/upsert-feature-documentation.js";

export const SERVER_METADATA = {
  name: "auto-docs-notion-mcp",
  version: "0.1.0",
} as const;

export const REGISTERED_TOOL_NAMES = [
  "initialize_project_manual",
  "capture_development_event",
  "analyze_documentation_candidate",
  "upsert_feature_documentation",
  "publish_or_queue_review",
  "package_manual",
  "get_documentation_status",
  "get_git_diff_summary",
  "get_runner_failure_triage_metadata",
  "get_runner_health_summary",
  "get_runner_release_automation_status",
  "set_runner_failure_triage_metadata",
  "run_autonomous_documentation_trigger",
  "capture_feature_screenshot",
  "configure_ai_provider",
  "export_manual_markdown",
  "export_manual_pdf",
  "export_help_center_content",
  "generate_pr_comment_preview",
  "publish_pr_comment",
  "generate_release_changelog",
  "run_release_documentation_pipeline",
  "sync_manual_to_local_docs",
] as const;

export function createServer() {
  const server = new McpServer({
    name: SERVER_METADATA.name,
    version: SERVER_METADATA.version,
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
  registerExtraTools(server);

  return server;
}
