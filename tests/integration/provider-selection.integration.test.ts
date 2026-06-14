import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { runWithRuntimeContext } from "../../src/lib/runtime-context.js";
import { StateStore } from "../../src/lib/state-store.js";
import { buildCandidate, resetProvider } from "../../src/providers/factory.js";
import { DeterministicProvider } from "../../src/providers/deterministic.js";
import { LMStudioProvider } from "../../src/providers/lmstudio.js";

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function startOpenAiServer(): Promise<{ server: Server; endpoint: string; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    calls.push(req.url ?? "");
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      await readBody(req);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  featureName: "Configured Provider Feature",
                  featureKey: "provider:configured",
                  shouldDocument: true,
                  audiences: ["User"],
                  userGuide: {
                    summary: "Configured provider produced this guide.",
                    steps: ["Open the configured workflow"],
                    expectedOutcome: "The provider-backed guide is generated.",
                    possibleErrors: [],
                  },
                  adminGuide: {
                    configRequired: ["No new configuration required"],
                    endpointsAffected: [],
                    envVarsRequired: [],
                    verificationSteps: ["Confirm provider response"],
                    troubleshooting: [],
                  },
                  confidenceScore: 88,
                  confidenceReasons: ["Configured provider responded."],
                  reviewQuestions: [],
                }),
              },
            },
          ],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start provider server.");
  return { server, endpoint: `http://127.0.0.1:${address.port}/v1`, calls };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function createAnalyzeFixture(): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-provider-selection-"));
  const statePath = join(stateDir, "state.json");
  process.env.AUTO_DOC_STATE_FILE = statePath;
  const store = new StateStore(statePath);
  await store.upsertProject({
    projectId: "project_1",
    projectName: "Acme",
    parentPageId: "parent_1",
    publishingMode: "Balanced",
    autoPublishThreshold: 90,
    projectPageId: "project_page_1",
    databases: {
      projectsDatabaseId: "projects",
      featuresDatabaseId: "features",
      manualEntriesDatabaseId: "manual",
      evidenceEventsDatabaseId: "events",
      releasesDatabaseId: "releases",
    },
    featuresByKey: {},
    eventsByExternalId: {},
    eventSnapshots: {},
  });
  await store.setEventSnapshot("project_1", "evt_1", {
    summary: "Added billing settings provider workflow",
    filesChanged: ["src/routes/billing/settings.tsx"],
    diffSummary: "Added /billing/settings route",
    eventType: "commit",
    source: "local_git",
    testStatus: "passed",
  });
}

async function handlers() {
  const server = new FakeServer();
  const { registerConfigureAiProviderTool } = await import("../../src/tools/configure-ai-provider.js");
  const { registerAnalyzeDocumentationCandidateTool } = await import("../../src/tools/analyze-documentation-candidate.js");
  registerConfigureAiProviderTool(server as unknown as McpServer);
  registerAnalyzeDocumentationCandidateTool(server as unknown as McpServer);
  return {
    configure: server.handlers.get("configure_ai_provider")!,
    analyze: server.handlers.get("analyze_documentation_candidate")!,
  };
}

afterEach(() => {
  resetProvider();
  delete process.env.AUTO_DOC_STATE_FILE;
  delete process.env.AI_PROVIDER_TYPE;
  delete process.env.AI_ENDPOINT;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL_NAME;
});

describe("prove-real-provider-selection", () => {
  it("configure_ai_provider changes the concrete provider used by the real factory and analyzer", async () => {
    await createAnalyzeFixture();
    const providerServer = await startOpenAiServer();
    try {
      await runWithRuntimeContext({}, async () => {
        const { configure, analyze } = await handlers();
        await configure({
          providerType: "deterministic",
          runHealthCheck: false,
        });
        expect(buildCandidate()).toBeInstanceOf(DeterministicProvider);

        await configure({
          providerType: "local-lmstudio",
          endpoint: providerServer.endpoint,
          apiKey: "test-key",
          modelName: "test-model",
          runHealthCheck: false,
        });
        expect(buildCandidate()).toBeInstanceOf(LMStudioProvider);

        const result = JSON.parse(
          (await analyze({ projectId: "project_1", evidenceEventIds: ["evt_1"] })).content[0].text,
        ) as { featureName: string; confidenceReasons: string[] };
        expect(result.featureName).toBe("Configured Provider Feature");
        expect(result.confidenceReasons.join(" ")).toContain("Provider used: local-lmstudio:test-model");
        expect(providerServer.calls).toContain("/v1/models");
        expect(providerServer.calls).toContain("/v1/chat/completions");
      });
    } finally {
      await close(providerServer.server);
    }
  });

  it("provider failure still falls back to deterministic analysis without mocking factory.ts", async () => {
    await createAnalyzeFixture();
    await runWithRuntimeContext({}, async () => {
      const { configure, analyze } = await handlers();
      await configure({
        providerType: "local-lmstudio",
        endpoint: "http://127.0.0.1:9/v1",
        apiKey: "test-key",
        modelName: "test-model",
        runHealthCheck: false,
      });
      const result = JSON.parse((await analyze({ projectId: "project_1", evidenceEventIds: ["evt_1"] })).content[0].text) as {
        confidenceReasons: string[];
      };
      expect(result.confidenceReasons.join(" ")).toContain("Provider used: deterministic");
    });
  });
});
