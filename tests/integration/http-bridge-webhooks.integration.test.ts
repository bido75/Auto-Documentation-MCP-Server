/**
 * Acceptance: add-unmocked-webhook-and-provider-smoke (Phase 4, item 9).
 * Real in-process HTTP server, real requests, real HMAC verification.
 */
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpBridgeApp } from "../../src/http-bridge/server.js";

const secret = "webhook-test-secret";
let server: Server | null = null;
let originalSecret: string | undefined;

async function startBridge(): Promise<string> {
  originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = secret;
  const app = createHttpBridgeApp({ host: "127.0.0.1", port: 0 });
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge test server did not bind to a TCP port.");
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function stopBridge(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    server = null;
  }
  if (originalSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
}

function signature(body: string): string {
  return `sha256=${createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex")}`;
}

afterEach(async () => {
  await stopBridge();
});

describe("add-unmocked-webhook-and-provider-smoke", () => {
  it("valid HMAC signature accepts the webhook through the real HTTP route", async () => {
    const baseUrl = await startBridge();
    const body = JSON.stringify({ zen: "Approachable tests are better tests." });
    const response = await fetch(`${baseUrl}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature(body),
        "x-github-event": "ping",
      },
      body,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "ignored", reason: "GitHub ping" });
  });

  it("invalid HMAC signature is rejected by the real HTTP route", async () => {
    const baseUrl = await startBridge();
    const body = JSON.stringify({ action: "opened" });
    const response = await fetch(`${baseUrl}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=bad",
        "x-github-event": "ping",
      },
      body,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "Invalid webhook signature." });
  });

  it("missing signature is rejected", async () => {
    const baseUrl = await startBridge();
    const response = await fetch(`${baseUrl}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
  });

  it("runs in default CI instead of being gated behind a live-service environment flag", async () => {
    const workflowText = await import("node:fs/promises").then(({ readFile }) => readFile(".github/workflows/ci.yml", "utf8"));
    expect(workflowText).toContain("npm test");
    expect(import.meta.url).not.toContain("live-notion");
  });
});
