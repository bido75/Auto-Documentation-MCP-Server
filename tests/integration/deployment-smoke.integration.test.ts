/**
 * Acceptance: fix-deployment-config-coherence (Phase 4, item 10).
 * These assertions keep deployment intent, CI gates, and runtime entrypoints aligned.
 */
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpBridgeApp } from "../../src/http-bridge/server.js";

let server: Server | null = null;

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
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
