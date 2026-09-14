/**
 * Acceptance: fix-deployment-config-coherence (Phase 4, item 10).
 * These assertions keep deployment intent, CI gates, and runtime entrypoints aligned.
 */
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpBridgeApp } from "../../src/http-bridge/server.js";

let server: Server | null = null;

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

type ComposeService = {
  profiles?: string[];
  command?: string[];
  environment?: Record<string, string>;
  ports?: string[];
};

type ComposeFile = {
  services: Record<string, ComposeService>;
};

async function composeFile(): Promise<ComposeFile> {
  return parse(await text("docker-compose.yml")) as ComposeFile;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    server = null;
  }
});

describe("fix-deployment-config-coherence", () => {
  it("default container mode and compose command use the documented bridge runtime", async () => {
    const dockerfile = await text("Dockerfile");
    const compose = await text("docker-compose.yml");
    const readme = await text("README.md");
    expect(dockerfile).toContain('CMD ["node", "build/src/cli/index.js", "bridge"]');
    expect(compose).toContain('command: ["node", "build/src/cli/index.js", "bridge"]');
    expect(readme).toContain("Container default: HTTP bridge mode");
  });

  it("bridge mode exposes a healthcheck endpoint that reports healthy with closed-default config", async () => {
    const app = createHttpBridgeApp({ host: "127.0.0.1", port: 0 });
    server = createServer(app);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Bridge health test did not bind to a TCP port.");

    const response = await fetch(`http://127.0.0.1:${(address as AddressInfo).port}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "running", transport: "http-sse" });
  });

  it("runner mode has a graceful SIGTERM shutdown hook", async () => {
    const runner = await text("src/runner/index.ts");
    expect(runner).toContain('process.once("SIGTERM", stopRunner)');
    expect(runner).toContain("runner.stop()");
  });

  it("self-hosted bridge passes provider and runner status environment through to the app", async () => {
    const compose = await composeFile();
    const bridge = compose.services["notion-auto-doc"];
    expect(bridge).toBeDefined();
    expect(bridge.command).toEqual(["node", "build/src/cli/index.js", "bridge"]);
    expect(bridge.environment).toMatchObject({
      AUTO_DOC_RUNTIME_MODE: "bridge",
      BIFROST_VIRTUAL_KEY: "${BIFROST_VIRTUAL_KEY:-}",
      AUTO_DOC_RUNNER_PROJECT_ID: "${AUTO_DOC_RUNNER_PROJECT_ID:-}",
      AUTO_DOC_RUNNER_REPO_PATH: "${AUTO_DOC_RUNNER_REPO_PATH:-}",
      AUTO_DOC_RUNNER_TARGETS: "${AUTO_DOC_RUNNER_TARGETS:-}",
      SELF_DOC_PROJECT_ID: "${SELF_DOC_PROJECT_ID:-}",
      SELF_DOC_REPO_PATH: "${SELF_DOC_REPO_PATH:-}",
    });
  });

  it("self-hosted runner has a real autonomous entrypoint and receives the same target/provider config", async () => {
    const compose = await composeFile();
    const runner = compose.services["notion-auto-doc-runner"];
    expect(runner).toBeDefined();
    expect(runner.profiles).toEqual(["runner"]);
    expect(runner.command).toEqual(["node", "build/src/index.js", "runner"]);
    expect(runner.environment).toMatchObject({
      AUTO_DOC_RUNTIME_MODE: "runner",
      BIFROST_VIRTUAL_KEY: "${BIFROST_VIRTUAL_KEY:-}",
      AUTO_DOC_RUNNER_PROJECT_ID: "${AUTO_DOC_RUNNER_PROJECT_ID:-}",
      AUTO_DOC_RUNNER_REPO_PATH: "${AUTO_DOC_RUNNER_REPO_PATH:-}",
      AUTO_DOC_RUNNER_TARGETS: "${AUTO_DOC_RUNNER_TARGETS:-}",
      SELF_DOC_PROJECT_ID: "${SELF_DOC_PROJECT_ID:-}",
      SELF_DOC_REPO_PATH: "${SELF_DOC_REPO_PATH:-}",
    });
  });

  it("bifrost gateway avoids the common localhost 8080 host-port collision", async () => {
    const compose = await composeFile();
    const bifrost = compose.services["bifrost-gateway"];
    expect(bifrost).toBeDefined();
    expect(bifrost.ports).toContain("127.0.0.1:8081:8080");
    expect(bifrost.ports).not.toContain("8080:8080");
  });

  it("autonomous orchestrator is wired through the capture analyze upsert publish pipeline", async () => {
    const orchestrator = await text("src/orchestrator/auto-doc-orchestrator.ts");
    expect(orchestrator).toContain("registerCaptureDevelopmentEventTool(server)");
    expect(orchestrator).toContain("registerAnalyzeDocumentationCandidateTool(server)");
    expect(orchestrator).toContain("registerUpsertFeatureDocumentationTool(server)");
    expect(orchestrator).toContain("registerPublishOrQueueReviewTool(server)");
    expect(orchestrator).not.toContain("return { ok: true }");
  });

  it("npm run lint script exists and is wired into CI", async () => {
    const packageJson = JSON.parse(await text("package.json")) as { scripts?: Record<string, string> };
    const ci = await text(".github/workflows/ci.yml");
    expect(packageJson.scripts?.lint).toBe("tsc --noEmit");
    expect(ci).toContain("npm run lint");
  });

  it("CI builds the image and starts bridge mode with secure defaults", async () => {
    const ci = await text(".github/workflows/ci.yml");
    expect(ci).toContain("docker build -t auto-docs-notion-mcp:ci .");
    expect(ci).toContain("STATE_ENCRYPTION_KEY=ci-secure-state-encryption-key-change-me");
    expect(ci).toContain("http://127.0.0.1:3000/health");
  });
});
