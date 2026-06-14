/**
 * Acceptance: isolate-provider-config-mutation (Phase 3, item 8) closes configure-provider-global-mutation.
 * These tests drive the real configure_ai_provider tool and the real provider factory.
 */
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runWithRuntimeContext } from "../../src/lib/runtime-context.js";
import { buildCandidate, resetProvider } from "../../src/providers/factory.js";
import { DeterministicProvider } from "../../src/providers/deterministic.js";
import { OllamaProvider } from "../../src/providers/ollama.js";
import { registerConfigureAiProviderTool } from "../../src/tools/configure-ai-provider.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

const providerEnvKeys = ["AI_PROVIDER_TYPE", "AI_ENDPOINT", "AI_API_KEY", "AI_MODEL_NAME"] as const;
let cwdBefore = process.cwd();
let envSnapshot: Record<(typeof providerEnvKeys)[number], string | undefined>;

function configureHandler(): ToolHandler {
  const server = new FakeServer();
  registerConfigureAiProviderTool(server as unknown as McpServer);
  const handler = server.handlers.get("configure_ai_provider");
  if (!handler) throw new Error("configure_ai_provider handler was not registered.");
  return handler;
}

function snapshotProviderEnv(): Record<(typeof providerEnvKeys)[number], string | undefined> {
  return Object.fromEntries(providerEnvKeys.map((key) => [key, process.env[key]])) as Record<
    (typeof providerEnvKeys)[number],
    string | undefined
  >;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

beforeEach(async () => {
  resetProvider();
  cwdBefore = process.cwd();
  envSnapshot = snapshotProviderEnv();
  process.chdir(await mkdtemp(join(tmpdir(), "auto-doc-provider-isolation-")));
  for (const key of providerEnvKeys) delete process.env[key];
});

afterEach(() => {
  resetProvider();
  process.chdir(cwdBefore);
  for (const key of providerEnvKeys) {
    const value = envSnapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("isolate-provider-config-mutation", () => {
  it("two interleaved sessions selecting different providers each resolve their own provider", async () => {
    const configure = configureHandler();
    await Promise.all([
      runWithRuntimeContext({}, async () => {
        await configure({ providerType: "deterministic", runHealthCheck: false });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(buildCandidate()).toBeInstanceOf(DeterministicProvider);
      }),
      runWithRuntimeContext({}, async () => {
        await configure({
          providerType: "local-ollama",
          endpoint: "http://127.0.0.1:11434",
          modelName: "llama3.2",
          runHealthCheck: false,
        });
        expect(buildCandidate()).toBeInstanceOf(OllamaProvider);
      }),
    ]);
  });

  it("process.env is not mutated during per-request provider selection", async () => {
    const configure = configureHandler();
    const before = snapshotProviderEnv();
    await runWithRuntimeContext({}, async () => {
      await configure({
        providerType: "local-ollama",
        endpoint: "http://127.0.0.1:11434",
        modelName: "local-model",
        runHealthCheck: false,
      });
      expect(buildCandidate()).toBeInstanceOf(OllamaProvider);
    });
    expect(snapshotProviderEnv()).toEqual(before);
  });

  it("no .env write occurs during request handling unless persistence is explicitly requested", async () => {
    const configure = configureHandler();
    await runWithRuntimeContext({}, async () => {
      await configure({ providerType: "deterministic", runHealthCheck: false });
    });
    expect(await exists(join(process.cwd(), ".env"))).toBe(false);
  });

  it("explicit setup persistence writes .env without making request-scoped selection global", async () => {
    const configure = configureHandler();
    await runWithRuntimeContext({}, async () => {
      await configure({
        providerType: "local-ollama",
        endpoint: "http://127.0.0.1:11434",
        modelName: "llama3.2",
        persistToEnv: true,
        runHealthCheck: false,
      });
      expect(buildCandidate()).toBeInstanceOf(OllamaProvider);
    });
    expect(await exists(join(process.cwd(), ".env"))).toBe(true);
    expect(snapshotProviderEnv()).toEqual({
      AI_PROVIDER_TYPE: undefined,
      AI_ENDPOINT: undefined,
      AI_API_KEY: undefined,
      AI_MODEL_NAME: undefined,
    });
  });
});
