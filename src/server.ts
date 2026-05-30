import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyzeDocumentationCandidateTool } from "./tools/analyze-documentation-candidate.js";
import { registerCaptureDevelopmentEventTool } from "./tools/capture-development-event.js";
import { registerCaptureFeatureScreenshotTool } from "./tools/capture-feature-screenshot.js";
import { registerConfigureAiProviderTool } from "./tools/configure-ai-provider.js";
import { registerExportManualMarkdownTool } from "./tools/export-manual-markdown.js";
import { registerExportManualPdfTool } from "./tools/export-manual-pdf.js";
import { registerExportHelpCenterContentTool } from "./tools/export-help-center-content.js";
import { registerGeneratePrCommentPreviewTool } from "./tools/generate-pr-comment-preview.js";
import { registerGenerateReleaseChangelogTool } from "./tools/generate-release-changelog.js";
import { registerGetDocumentationStatusTool } from "./tools/get-documentation-status.js";
import { registerGetGitDiffSummaryTool } from "./tools/get-git-diff-summary.js";
import { registerGetRunnerFailureTriageMetadataTool } from "./tools/get-runner-failure-triage-metadata.js";
import { registerGetRunnerHealthSummaryTool } from "./tools/get-runner-health-summary.js";
import { registerGetRunnerReleaseAutomationStatusTool } from "./tools/get-runner-release-automation-status.js";
import { registerInitializeProjectManualTool } from "./tools/initialize-project-manual.js";
import { registerPackageManualTool } from "./tools/package-manual.js";
import { registerPublishPrCommentTool } from "./tools/publish-pr-comment.js";
import { registerPublishOrQueueReviewTool } from "./tools/publish-or-queue-review.js";
import { registerRunAutonomousDocumentationTriggerTool } from "./tools/run-autonomous-documentation-trigger.js";
import { registerRunReleaseDocumentationPipelineTool } from "./tools/run-release-documentation-pipeline.js";
import { registerSetRunnerFailureTriageMetadataTool } from "./tools/set-runner-failure-triage-metadata.js";
import { registerSyncManualToLocalDocsTool } from "./tools/sync-manual-to-local-docs.js";
import { registerUpsertFeatureDocumentationTool } from "./tools/upsert-feature-documentation.js";

type ToolRegistrar = {
  name: string;
  register: (server: McpServer) => void;
};

export const SERVER_METADATA = {
  name: "auto-docs-notion-mcp",
  version: "0.1.0",
} as const;

const TOOL_REGISTRARS: ToolRegistrar[] = [
  { name: "initialize_project_manual", register: registerInitializeProjectManualTool },
  { name: "capture_development_event", register: registerCaptureDevelopmentEventTool },
  { name: "analyze_documentation_candidate", register: registerAnalyzeDocumentationCandidateTool },
  { name: "upsert_feature_documentation", register: registerUpsertFeatureDocumentationTool },
  { name: "publish_or_queue_review", register: registerPublishOrQueueReviewTool },
  { name: "package_manual", register: registerPackageManualTool },
  { name: "get_documentation_status", register: registerGetDocumentationStatusTool },
  { name: "get_git_diff_summary", register: registerGetGitDiffSummaryTool },
  { name: "get_runner_failure_triage_metadata", register: registerGetRunnerFailureTriageMetadataTool },
  { name: "get_runner_health_summary", register: registerGetRunnerHealthSummaryTool },
  { name: "get_runner_release_automation_status", register: registerGetRunnerReleaseAutomationStatusTool },
  { name: "set_runner_failure_triage_metadata", register: registerSetRunnerFailureTriageMetadataTool },
  { name: "run_autonomous_documentation_trigger", register: registerRunAutonomousDocumentationTriggerTool },
  { name: "capture_feature_screenshot", register: registerCaptureFeatureScreenshotTool },
  { name: "configure_ai_provider", register: registerConfigureAiProviderTool },
  { name: "export_manual_markdown", register: registerExportManualMarkdownTool },
  { name: "export_manual_pdf", register: registerExportManualPdfTool },
  { name: "export_help_center_content", register: registerExportHelpCenterContentTool },
  { name: "generate_pr_comment_preview", register: registerGeneratePrCommentPreviewTool },
  { name: "publish_pr_comment", register: registerPublishPrCommentTool },
  { name: "generate_release_changelog", register: registerGenerateReleaseChangelogTool },
  { name: "run_release_documentation_pipeline", register: registerRunReleaseDocumentationPipelineTool },
  { name: "sync_manual_to_local_docs", register: registerSyncManualToLocalDocsTool },
];

export const REGISTERED_TOOL_NAMES = TOOL_REGISTRARS.map((tool) => tool.name);

export function createServer() {
  const server = new McpServer(SERVER_METADATA);

  for (const tool of TOOL_REGISTRARS) {
    tool.register(server);
  }

  return server;
}
