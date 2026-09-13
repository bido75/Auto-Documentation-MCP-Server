import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerAssembleManualTool } from "./assemble-manual.js";
import { registerConfigureAiProviderTool } from "./configure-ai-provider.js";
import { registerCaptureOcrReviewTool } from "./capture-ocr-review.js";
import { registerDiscoverProjectFromNotionTool } from "./discover-project-from-notion.js";
import { registerExportManualPdfTool } from "./export-manual-pdf.js";
import { registerExportHelpCenterContentTool } from "./export-help-center-content.js";
import { registerGenerateGapReportTool } from "./generate-gap-report.js";
import { registerGeneratePrCommentPreviewTool } from "./generate-pr-comment-preview.js";
import { registerGenerateReleaseChangelogTool } from "./generate-release-changelog.js";
import { registerGetRunnerFailureTriageMetadataTool } from "./get-runner-failure-triage-metadata.js";
import { registerGetRunnerHealthSummaryTool } from "./get-runner-health-summary.js";
import { registerGetRunnerReleaseAutomationStatusTool } from "./get-runner-release-automation-status.js";
import { registerHealthCheckTool } from "./health-check.js";
import { registerHumanizeManualTool } from "./humanize-manual.js";
import { registerPublishPrCommentTool } from "./publish-pr-comment.js";
import { registerProbeApplicationTool } from "./probe-application.js";
import { registerRunAutonomousDocumentationTriggerTool } from "./run-autonomous-documentation-trigger.js";
import { registerRunReleaseDocumentationPipelineTool } from "./run-release-documentation-pipeline.js";
import { registerSetRunnerFailureTriageMetadataTool } from "./set-runner-failure-triage-metadata.js";
import { registerSynthesizeMissingContentTool } from "./synthesize-missing-content.js";
import { registerSyncManualToLocalDocsTool } from "./sync-manual-to-local-docs.js";

export function registerExtraTools(server: McpServer) {
  registerAssembleManualTool(server);
  registerConfigureAiProviderTool(server);
  registerCaptureOcrReviewTool(server);
  registerDiscoverProjectFromNotionTool(server);
  registerExportManualPdfTool(server);
  registerExportHelpCenterContentTool(server);
  registerGenerateGapReportTool(server);
  registerGeneratePrCommentPreviewTool(server);
  registerGenerateReleaseChangelogTool(server);
  registerGetRunnerFailureTriageMetadataTool(server);
  registerGetRunnerHealthSummaryTool(server);
  registerGetRunnerReleaseAutomationStatusTool(server);
  registerHealthCheckTool(server);
  registerHumanizeManualTool(server);
  registerPublishPrCommentTool(server);
  registerProbeApplicationTool(server);
  registerRunAutonomousDocumentationTriggerTool(server);
  registerRunReleaseDocumentationPipelineTool(server);
  registerSetRunnerFailureTriageMetadataTool(server);
  registerSynthesizeMissingContentTool(server);
  registerSyncManualToLocalDocsTool(server);
}
