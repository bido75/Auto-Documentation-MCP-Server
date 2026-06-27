import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { runWithRuntimeContext } from "../../src/lib/runtime-context.js";
import { assertRepoPathAllowed } from "../../src/lib/repo-paths.js";
import { registerConfigureAiProviderTool } from "../../src/tools/configure-ai-provider.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: {
  providerType: string;
  endpoint?: string;
  modelName?: string;
  persistToEnv?: boolean;
  runHealthCheck?: boolean;
  traceId?: string;
}) => Promise<ToolResult>;

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

function configureHandler(): ToolHandler {
  const server = new FakeServer();
  registerConfigureAiProviderTool(server as unknown as McpServer);
  const handler = server.handlers.get("configure_ai_provider");
  if (!handler) {
    throw new Error("configure_ai_provider handler missing");
  }
  return handler;
}

describe("security hardening", () => {
  const previousAllowedRoots = process.env.AUTO_DOC_ALLOWED_REPO_ROOTS;
  const previousProviderLocalEndpoints = process.env.AUTO_DOC_PROVIDER_ALLOW_LOCAL_ENDPOINTS;
  const previousAllowRemoteProviderConfig = process.env.AUTO_DOC_ALLOW_REMOTE_PROVIDER_CONFIG;

  afterEach(() => {
    if (previousAllowedRoots === undefined) delete process.env.AUTO_DOC_ALLOWED_REPO_ROOTS;
    else process.env.AUTO_DOC_ALLOWED_REPO_ROOTS = previousAllowedRoots;

    if (previousProviderLocalEndpoints === undefined) delete process.env.AUTO_DOC_PROVIDER_ALLOW_LOCAL_ENDPOINTS;
    else process.env.AUTO_DOC_PROVIDER_ALLOW_LOCAL_ENDPOINTS = previousProviderLocalEndpoints;

    if (previousAllowRemoteProviderConfig === undefined) delete process.env.AUTO_DOC_ALLOW_REMOTE_PROVIDER_CONFIG;
    else process.env.AUTO_DOC_ALLOW_REMOTE_PROVIDER_CONFIG = previousAllowRemoteProviderConfig;
  });

  it("rejects configure_ai_provider from a remote bridge context by default", async () => {
    const handler = configureHandler();

    await expect(
      runWithRuntimeContext({ bridge: { remote: true } }, () =>
        handler({
          providerType: "cloud-openai",
          endpoint: "https://api.openai.com/v1",
          modelName: "gpt-test",
          persistToEnv: false,
          runHealthCheck: false,
        }),
      ),
    ).rejects.toThrow(/remote bridge/i);
  });

  it("rejects private, loopback, and metadata provider endpoints", async () => {
    const handler = configureHandler();

    await expect(
      handler({
        providerType: "cloud-openai",
        endpoint: "http://169.254.169.254/latest/meta-data",
        modelName: "test-model",
        runHealthCheck: false,
      }),
    ).rejects.toThrow(/provider endpoint/i);

    await expect(
      handler({
        providerType: "cloud-openai",
        endpoint: "http://127.0.0.1:11434/v1",
        modelName: "test-model",
        runHealthCheck: false,
      }),
    ).rejects.toThrow(/provider endpoint/i);

    await expect(
      handler({
        providerType: "cloud-openai",
        endpoint: "http://10.0.0.219:11434/v1",
        modelName: "test-model",
        runHealthCheck: false,
      }),
    ).rejects.toThrow(/provider endpoint/i);
  });

  it("allows repo paths only inside configured roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-doc-allowed-root-"));
    const inside = join(root, "repo");
    const outside = resolve(root, "..", `${basename(root)}-outside`);
    process.env.AUTO_DOC_ALLOWED_REPO_ROOTS = root;

    await expect(assertRepoPathAllowed(inside)).resolves.toBe(resolve(inside));
    await expect(assertRepoPathAllowed(outside)).rejects.toThrow(/not allowed/i);
  });

  it("rejects symlink escapes from an allowed repo root", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-doc-allowed-root-"));
    const outside = await mkdtemp(join(tmpdir(), "auto-doc-outside-root-"));
    const link = join(root, "linked-outside");
    process.env.AUTO_DOC_ALLOWED_REPO_ROOTS = root;

    await symlink(outside, link, "junction");

    await expect(assertRepoPathAllowed(link)).rejects.toThrow(/not allowed/i);
  });
});
