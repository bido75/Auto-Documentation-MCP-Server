import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpBridgeApp } from "../../src/http-bridge/server.js";

const originalEnv = {
  nodeEnv: process.env.NODE_ENV,
  apiUrl: process.env.LEMONSQUEEZY_LICENSE_API_URL,
  productId: process.env.LEMONSQUEEZY_PRODUCT_ID,
  variantId: process.env.LEMONSQUEEZY_VARIANT_ID,
  privateKeyPath: process.env.AUTO_DOC_LICENSE_PRIVATE_KEY_PATH,
};
let bridge: Server | null = null;
let validator: Server | null = null;
let temporaryDirectory: string | null = null;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port.");
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function configureTest(productId: number): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "auto-doc-license-exchange-"));
  const privateKeyPath = join(temporaryDirectory, "license-private.pem");
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await writeFile(privateKeyPath, pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(), "utf8");

  validator = createServer((_req, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      valid: true,
      license_key: { status: "active", expires_at: null },
      meta: { product_id: productId, variant_id: 456, customer_email: "buyer@example.test" },
    }));
  });
  const validatorUrl = await listen(validator);

  process.env.NODE_ENV = "test";
  process.env.LEMONSQUEEZY_LICENSE_API_URL = `${validatorUrl}/v1/licenses/validate`;
  process.env.LEMONSQUEEZY_PRODUCT_ID = "123";
  process.env.LEMONSQUEEZY_VARIANT_ID = "456";
  process.env.AUTO_DOC_LICENSE_PRIVATE_KEY_PATH = privateKeyPath;

  bridge = createServer(createHttpBridgeApp({ host: "127.0.0.1", port: 0 }));
  return listen(bridge);
}

afterEach(async () => {
  for (const server of [bridge, validator]) {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  bridge = null;
  validator = null;
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
  for (const [key, value] of Object.entries({
    NODE_ENV: originalEnv.nodeEnv,
    LEMONSQUEEZY_LICENSE_API_URL: originalEnv.apiUrl,
    LEMONSQUEEZY_PRODUCT_ID: originalEnv.productId,
    LEMONSQUEEZY_VARIANT_ID: originalEnv.variantId,
    AUTO_DOC_LICENSE_PRIVATE_KEY_PATH: originalEnv.privateKeyPath,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("license exchange", () => {
  it("validates the Lemon key and returns an offline-signed Auto-Doc JWT", async () => {
    const baseUrl = await configureTest(123);
    const response = await fetch(`${baseUrl}/license/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ licenseKey: "lemon-issued-key", email: "buyer@example.test" }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok?: boolean; licenseKey?: string };
    expect(payload.ok).toBe(true);
    expect(payload.licenseKey?.split(".")).toHaveLength(3);
  });

  it("rejects a valid Lemon key belonging to another product", async () => {
    const baseUrl = await configureTest(999);
    const response = await fetch(`${baseUrl}/license/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ licenseKey: "foreign-product-key", email: "buyer@example.test" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "The license key does not belong to Auto-Doc MCP." });
  });
});
