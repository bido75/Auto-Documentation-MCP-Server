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
  restart?: string;
  volumes?: string[];
  depends_on?: Record<string, { condition?: string }>;
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
      LEMONSQUEEZY_WEBHOOK_SECRET: "${LEMONSQUEEZY_WEBHOOK_SECRET:-}",
      AUTO_DOC_LICENSE_PRIVATE_KEY_PATH: "${AUTO_DOC_LICENSE_PRIVATE_KEY_PATH:-/run/auto-doc-license/license-private.pem}",
    });
    expect(bridge.volumes).toContain("${AUTO_DOC_LICENSE_KEYS_DIR:-./license-keys}:/run/auto-doc-license:ro");
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

  it("keeps Bifrost private to the Docker network to avoid host-port collisions", async () => {
    const compose = await composeFile();
    const bifrost = compose.services["bifrost-gateway"];
    expect(bifrost).toBeDefined();
    expect(bifrost.ports).toBeUndefined();
  });

  it("orders healthy origins before nginx and cloudflared", async () => {
    const compose = await composeFile();
    const cloudflared = compose.services.cloudflared;
    const nginx = compose.services.nginx;
    expect(cloudflared).toBeDefined();
    expect(cloudflared.profiles).toEqual(["self-hosted"]);
    expect(cloudflared.restart).toBe("unless-stopped");
    expect(cloudflared.depends_on).toMatchObject({
      nginx: { condition: "service_started" },
      "notion-auto-doc": { condition: "service_healthy" },
    });
    expect(nginx.depends_on).toMatchObject({
      "bifrost-gateway": { condition: "service_healthy" },
      "notion-auto-doc": { condition: "service_healthy" },
    });
  });

  it("bundles Linux and Windows boot launchers that include the self-hosted profile", async () => {
    const systemdUnit = await text("deploy/systemd/auto-doc-mcp.service");
    const linuxInstaller = await text("deploy/systemd/install.sh");
    const windowsLauncher = await text("scripts/start-self-hosted.ps1");
    const windowsInstaller = await text("scripts/register-windows-autostart.ps1");

    expect(systemdUnit).toContain("docker compose --profile self-hosted up -d");
    expect(systemdUnit).toContain("WantedBy=multi-user.target");
    expect(linuxInstaller).toContain("systemctl enable --now auto-doc-mcp.service");
    expect(windowsLauncher).toContain("docker compose --profile self-hosted up -d");
    expect(windowsLauncher).toContain("CLOUDFLARE_TUNNEL_TOKEN");
    expect(windowsLauncher).toContain('ContainerName "bifrost-gateway" -ExpectedState "healthy"');
    expect(windowsInstaller).toContain("New-ScheduledTaskTrigger -AtLogOn");
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
