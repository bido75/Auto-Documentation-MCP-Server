import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getLicenseStatus, requiresLicense } from "../../src/lib/license.js";

function signLicense(input: {
  privateKey: string;
  subject?: string;
  expiresAtSeconds?: number;
  store?: string;
  plan?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      sub: input.subject ?? "user@example.com",
      iat: now,
      exp: input.expiresAtSeconds ?? now + 30 * 24 * 60 * 60,
      plan: input.plan ?? "maintenance",
      activations: 3,
      store: input.store ?? "auto-doc-mcp",
    }),
    "utf8",
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${signer.sign(input.privateKey, "base64url")}`;
}

function createKeys(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("offline license validation", () => {
  it("accepts a valid signed maintenance license", () => {
    const keys = createKeys();
    const token = signLicense({ privateKey: keys.privateKey });

    const status = getLicenseStatus({
      AUTO_DOC_LICENSE_KEY: token,
      AUTO_DOC_LICENSE_PUBLIC_KEY: keys.publicKey,
    });

    expect(status.valid).toBe(true);
    if (status.valid) {
      expect(status.plan).toBe("maintenance");
      expect(status.subject).toBe("user@example.com");
    }
  });

  it("rejects tampered signatures", () => {
    const keys = createKeys();
    const token = signLicense({ privateKey: keys.privateKey });
    const tampered = `${token.slice(0, -2)}aa`;

    const status = getLicenseStatus({
      AUTO_DOC_LICENSE_KEY: tampered,
      AUTO_DOC_LICENSE_PUBLIC_KEY: keys.publicKey,
    });

    expect(status).toEqual({ valid: false, reason: "invalid_signature" });
  });

  it("allows the seven day grace period and rejects licenses after it", () => {
    const keys = createKeys();
    const nowSeconds = 2_000_000;
    const token = signLicense({ privateKey: keys.privateKey, expiresAtSeconds: nowSeconds - 24 * 60 * 60 });

    const graceStatus = getLicenseStatus(
      {
        AUTO_DOC_LICENSE_KEY: token,
        AUTO_DOC_LICENSE_PUBLIC_KEY: keys.publicKey,
      },
      new Date(nowSeconds * 1000),
    );

    expect(graceStatus.valid).toBe(true);

    const expiredStatus = getLicenseStatus(
      {
        AUTO_DOC_LICENSE_KEY: token,
        AUTO_DOC_LICENSE_PUBLIC_KEY: keys.publicKey,
      },
      new Date((nowSeconds + 8 * 24 * 60 * 60) * 1000),
    );

    expect(expiredStatus.valid).toBe(false);
    if (!expiredStatus.valid) {
      expect(expiredStatus.reason).toBe("expired");
    }
  });

  it("keeps core tools free and gates provider-backed advanced tools", () => {
    expect(requiresLicense("initialize_project_manual", {})).toBe(false);
    expect(requiresLicense("capture_development_event", {})).toBe(false);
    expect(requiresLicense("configure_ai_provider", {})).toBe(false);
    expect(requiresLicense("analyze_documentation_candidate", { AI_PROVIDER_TYPE: "deterministic" })).toBe(false);
    expect(requiresLicense("analyze_documentation_candidate", { AI_PROVIDER_TYPE: "cloud-openai" })).toBe(true);
    expect(requiresLicense("probe_application", {})).toBe(true);
    expect(requiresLicense("export_manual_pdf", {})).toBe(true);
  });
});
