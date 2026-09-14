import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyzeDocumentationCandidateTool } from "./tools/analyze-documentation-candidate.js";
import { registerAttachVisualEvidenceTool } from "./tools/attach-visual-evidence.js";
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
import { checkLicenseGate } from "./lib/license-gate.js";

export const SERVER_METADATA = {
  name: "auto-docs-notion-mcp",
  version: "0.3.0",
} as const;

export const REGISTERED_TOOL_NAMES = [
  "initialize_project_manual",
  "capture_development_event",
  "analyze_documentation_candidate",
  "upsert_feature_documentation",
  "publish_or_queue_review",
  "package_manual",
  "get_documentation_status",
  "get_documentation_health",
  "get_git_diff_summary",
  "get_runner_failure_triage_metadata",
  "get_runner_health_summary",
  "get_runner_release_automation_status",
  "health_check",
  "humanize_manual",
  "humanize_content",
  "probe_application",
  "generate_gap_report",
  "synthesize_missing_content",
  "capture_ocr_review",
  "set_runner_failure_triage_metadata",
  "run_autonomous_documentation_trigger",
  "attach_visual_evidence",
  "capture_feature_screenshot",
  "assemble_manual",
  "configure_ai_provider",
  "configure_webhook",
  "discover_project_from_notion",
  "export_manual_markdown",
  "export_manual_pdf",
  "export_help_center_content",
  "generate_pr_comment_preview",
  "publish_pr_comment",
  "generate_release_changelog",
  "run_release_documentation_pipeline",
  "sync_manual_to_local_docs",
  "trigger_webhook_test",
] as const;

function createLicenseGatedServer(server: McpServer): McpServer {
  const originalTool = server.tool.bind(server);
  const gatedServer = Object.create(server) as McpServer;

  gatedServer.tool = ((name: string, ...rest: unknown[]) => {
    let handlerIndex = -1;
    for (let index = rest.length - 1; index >= 0; index -= 1) {
      if (typeof rest[index] === "function") {
        handlerIndex = index;
        break;
      }
    }
    if (handlerIndex < 0) {
      return Reflect.apply(originalTool, server, [name, ...rest]) as ReturnType<McpServer["tool"]>;
    }

    const originalHandler = rest[handlerIndex] as (...args: unknown[]) => unknown;
    const wrappedHandler = async (...args: unknown[]) => {
      const gate = checkLicenseGate(name);
      if (!gate.allowed) {
        return gate.response;
      }

      return Reflect.apply(originalHandler, undefined, args);
    };
    const wrappedRest = [...rest];
    wrappedRest[handlerIndex] = wrappedHandler;

    return Reflect.apply(originalTool, server, [name, ...wrappedRest]) as ReturnType<McpServer["tool"]>;
  }) as McpServer["tool"];

  return gatedServer;
}

export function createServer() {
  const server = new McpServer({
    name: SERVER_METADATA.name,
    version: SERVER_METADATA.version,
  });
  const toolServer = createLicenseGatedServer(server);

  registerInitializeProjectManualTool(toolServer);
  registerCaptureDevelopmentEventTool(toolServer);
  registerAnalyzeDocumentationCandidateTool(toolServer);
  registerUpsertFeatureDocumentationTool(toolServer);
  registerPublishOrQueueReviewTool(toolServer);
  registerPackageManualTool(toolServer);
  registerGetDocumentationStatusTool(toolServer);
  registerGetGitDiffSummaryTool(toolServer);
  registerAttachVisualEvidenceTool(toolServer);
  registerCaptureFeatureScreenshotTool(toolServer);
  registerExportManualMarkdownTool(toolServer);
  registerExtraTools(toolServer);

  return server;
}
