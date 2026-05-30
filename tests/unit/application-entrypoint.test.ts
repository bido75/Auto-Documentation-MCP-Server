import { beforeEach, describe, expect, it, vi } from "vitest";

const connect = vi.fn();
const runner = vi.fn();
const startHttpBridge = vi.fn();
const resolveToken = vi.fn(async () => null);
const runPostCommitTrigger = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  class MockTransport {}

  return {
    StdioServerTransport: MockTransport,
  };
});

vi.mock("../../src/server.js", () => ({
  createServer: () => ({ connect }),
}));

vi.mock("../../src/runner/index.js", () => ({
  runContinuousDocumentationRunner: runner,
}));

vi.mock("../../src/http-bridge/server.js", () => ({
  startHttpBridge,
}));

vi.mock("../../src/installer/token-store.js", () => ({
  resolveToken,
}));

vi.mock("../../src/cli/post-commit.js", () => ({
  runPostCommitTrigger,
}));

describe("runApplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts the MCP server by default when background prerequisites are not configured", async () => {
    connect.mockResolvedValueOnce(undefined);
    const { runApplication } = await import("../../src/index.js");

    await runApplication(["node", "index.js"], {});

    expect(connect).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
    expect(startHttpBridge).not.toHaveBeenCalled();
    expect(runPostCommitTrigger).not.toHaveBeenCalled();
  });

  it("starts the MCP server by default", async () => {
    connect.mockResolvedValueOnce(undefined);
    const { runApplication } = await import("../../src/index.js");

    await runApplication(["node", "index.js", "mcp"], {});

    expect(connect).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();
  });

  it("dispatches to auto runner mode and starts bridge when configured", async () => {
    const { runApplication } = await import("../../src/index.js");
    startHttpBridge.mockResolvedValueOnce(undefined);

    await runApplication(["node", "index.js"], {
      NOTION_TOKEN: "token",
      AUTO_DOC_RUNNER_PROJECT_ID: "proj_1",
      AUTO_DOC_RUNNER_REPO_PATH: "C:/repo",
      AUTO_DOC_AUTO_START_HTTP_BRIDGE: "true",
    });

    expect(startHttpBridge).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("dispatches to the runner mode when requested", async () => {
    const { runApplication } = await import("../../src/index.js");

    await runApplication(["node", "index.js", "runner"], {
      NOTION_TOKEN: "token",
      AUTO_DOC_RUNNER_PROJECT_ID: "proj_1",
      AUTO_DOC_RUNNER_REPO_PATH: "C:/repo",
    });

    expect(runner).toHaveBeenCalledTimes(1);
  });
});