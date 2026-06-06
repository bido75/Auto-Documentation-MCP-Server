import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerConfigureAiProviderTool } from "./configure-ai-provider.js";
import { registerExportManualPdfTool } from "./export-manual-pdf.js";
import { registerExportHelpCenterContentTool } from "./export-help-center-content.js";
import { registerGeneratePrCommentPreviewTool } from "./generate-pr-comment-preview.js";
import { registerGenerateReleaseChangelogTool } from "./generate-release-changelog.js";
import { registerGetRunnerFailureTriageMetadataTool } from "./get-runner-failure-triage-metadata.js";
import { registerGetRunnerHealthSummaryTool } from "./get-runner-health-summary.js";
import { registerGetRunnerReleaseAutomationStatusTool } from "./get-runner-release-automation-status.js";
import { registerPublishPrCommentTool } from "./publish-pr-comment.js";
import { registerRunAutonomousDocumentationTriggerTool } from "./run-autonomous-documentation-trigger.js";
import { registerRunReleaseDocumentationPipelineTool } from "./run-release-documentation-pipeline.js";
import { registerSetRunnerFailureTriageMetadataTool } from "./set-runner-failure-triage-metadata.js";
import { registerSyncManualToLocalDocsTool } from "./sync-manual-to-local-docs.js";

export function registerExtraTools(server: McpServer) {
  registerConfigureAiProviderTool(server);
  registerExportManualPdfTool(server);
  registerExportHelpCenterContentTool(server);
  registerGeneratePrCommentPreviewTool(server);
  registerGenerateReleaseChangelogTool(server);
  registerGetRunnerFailureTriageMetadataTool(server);
  registerGetRunnerHealthSummaryTool(server);
  registerGetRunnerReleaseAutomationStatusTool(server);
  registerPublishPrCommentTool(server);
  registerRunAutonomousDocumentationTriggerTool(server);
  registerRunReleaseDocumentationPipelineTool(server);
  registerSetRunnerFailureTriageMetadataTool(server);
  registerSyncManualToLocalDocsTool(server);
}