import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpBridgeApp } from "../../src/http-bridge/server.js";

const secret = "lemon-test-secret";
let server: Server | null = null;
let temporaryDirectory: string | null = null;
const originalSecret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
const originalPrivateKeyPath = process.env.AUTO_DOC_LICENSE_PRIVATE_KEY_PATH;

async function startBridge(): Promise<string> {
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = secret;
  const app = createHttpBridgeApp({ host: "127.0.0.1", port: 0 });
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge test server did not bind to a TCP port.");
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

function webhookBody(): string {
  return JSON.stringify({
    meta: { event_name: "subscription_created" },
    data: { attributes: { user_email: "subscriber@example.test" } },
  });
}

function signature(body: string): string {
  return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

async function sendWebhook(baseUrl: string, body: string): Promise<Response> {
  return fetch(`${baseUrl}/webhooks/lemonsqueezy`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": signature(body) },
    body,
  });
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    server = null;
  }
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
  if (originalSecret === undefined) delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  else process.env.LEMONSQUEEZY_WEBHOOK_SECRET = originalSecret;
  if (originalPrivateKeyPath === undefined) delete process.env.AUTO_DOC_LICENSE_PRIVATE_KEY_PATH;
  else process.env.AUTO_DOC_LICENSE_PRIVATE_KEY_PATH = originalPrivateKeyPath;
});

describe("Lemon Squeezy license webhook", () => {
  it("fails closed with a controlled response when the signing key is unavailable", async () => {
    process.env.AUTO_DOC_LICENSE_PRIVATE_KEY_PATH = join(tmpdir(), "missing-auto-doc-license-key.pem");
    const baseUrl = await startBridge();
    const response = await sendWebhook(baseUrl, webhookBody());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "The license signing key is unavailable; license issuance is temporarily disabled.",
    });
  });

  it("issues a signed license through the real HTTP route when the mounted key is available", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "auto-doc-license-"));
    const privateKeyPath = join(temporaryDirectory, "license-private.pem");
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(privateKeyPath, pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(), "utf8");
    process.env.AUTO_DOC_LICENSE_PRIVATE_KEY_PATH = privateKeyPath;
    const baseUrl = await startBridge();
    const response = await sendWebhook(baseUrl, webhookBody());

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok?: boolean; status?: string; licenseKey?: string };
    expect(payload).toMatchObject({ ok: true, status: "issued" });
    expect(payload.licenseKey?.split(".")).toHaveLength(3);
  });
});
