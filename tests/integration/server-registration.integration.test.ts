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
    expect(toolNames).toContain("humanize_manual");
    expect(toolNames).toContain("humanize_content");
    expect(toolNames).toContain("probe_application");
    expect(toolNames).toContain("generate_gap_report");
    expect(toolNames).toContain("synthesize_missing_content");
    expect(toolNames).toContain("capture_ocr_review");
    expect(toolNames).toContain("get_documentation_health");
    expect(toolNames).toContain("configure_webhook");
    expect(toolNames).toContain("trigger_webhook_test");
    expect(toolNames).toHaveLength(36);
  }, 15_000);
});
