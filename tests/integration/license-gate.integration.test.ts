import { afterEach, describe, expect, it, vi } from "vitest";
import { resetLicenseCacheForTests } from "../../src/lib/license.js";
import { resetLicenseGateForTests } from "../../src/lib/license-gate.js";

type ToolHandler = (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;

const handlers = vi.hoisted(() => new Map<string, ToolHandler>());

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  class MockMcpServer {
    constructor(_meta: unknown) {}

    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
      handlers.set(name, handler);
    }
  }

  return {
    McpServer: MockMcpServer,
  };
});

describe("MCP license gate", () => {
  afterEach(() => {
    handlers.clear();
    delete process.env.AUTO_DOC_LICENSE_KEY;
    delete process.env.AUTO_DOC_LICENSE_PUBLIC_KEY;
    delete process.env.AI_PROVIDER_TYPE;
    resetLicenseCacheForTests();
    resetLicenseGateForTests();
    vi.resetModules();
  });

  it("blocks advanced tools before their implementation runs when no license is configured", async () => {
    handlers.clear();
    const { createServer } = await import("../../src/server.js");
    createServer();

    const handler = handlers.get("package_manual");
    expect(handler).toBeDefined();

    const result = await handler?.({ projectId: "missing-project", releaseVersion: "test" });
    const payload = JSON.parse(result?.content[0]?.text ?? "{}") as Record<string, unknown>;

    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("AUTO_DOC_LICENSE_REQUIRED");
    expect(payload.tool).toBe("package_manual");
    expect(String(payload.message)).toContain("Core tools remain free");
  });

  it("does not gate deterministic analysis", async () => {
    process.env.AI_PROVIDER_TYPE = "deterministic";
    handlers.clear();
    const { createServer } = await import("../../src/server.js");
    createServer();

    const handler = handlers.get("analyze_documentation_candidate");
    expect(handler).toBeDefined();

    await expect(handler?.({ projectId: "missing-project", evidenceEventIds: [] })).rejects.toThrow(/Unknown projectId|ANALYZE_DOCUMENTATION_CANDIDATE_FAILED/);
  });
});
