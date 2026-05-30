import { describe, expect, it, vi } from "vitest";

const toolNames = vi.hoisted(() => [] as string[]);

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  class MockMcpServer {
    constructor(_meta: unknown) {}

    tool(name: string) {
      toolNames.push(name);
    }
  }

  return {
    McpServer: MockMcpServer,
  };
});

describe("createServer tool registration", () => {
  it("registers initialize, capture, analyze, upsert, and package handlers through createServer", async () => {
    toolNames.length = 0;

    const { createServer } = await import("../../src/server.js");
    createServer();

    expect(toolNames).toContain("initialize_project_manual");
    expect(toolNames).toContain("capture_development_event");
    expect(toolNames).toContain("analyze_documentation_candidate");
    expect(toolNames).toContain("upsert_feature_documentation");
    expect(toolNames).toContain("package_manual");
    expect(toolNames).toContain("get_runner_health_summary");
    expect(toolNames).toContain("get_runner_release_automation_status");
    expect(toolNames).toContain("get_runner_failure_triage_metadata");
    expect(toolNames).toContain("set_runner_failure_triage_metadata");
    expect(toolNames).toContain("run_autonomous_documentation_trigger");
    expect(toolNames).toContain("configure_ai_provider");
    expect(toolNames).toContain("generate_pr_comment_preview");
    expect(toolNames).toContain("publish_pr_comment");
    expect(toolNames).toContain("generate_release_changelog");
    expect(toolNames).toContain("run_release_documentation_pipeline");
    expect(toolNames).toContain("export_manual_pdf");
    expect(toolNames).toContain("export_help_center_content");
    expect(toolNames).toContain("sync_manual_to_local_docs");
  });
});
