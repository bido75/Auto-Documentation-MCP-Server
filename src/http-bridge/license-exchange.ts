import type { Request, Response as ExpressResponse } from "express";
import { generateLicenseJwt } from "./webhooks/lemonsqueezy.js";

type LemonLicenseResponse = {
  valid?: boolean;
  error?: string | null;
  license_key?: { status?: string; expires_at?: string | null };
  meta?: {
    product_id?: number;
    variant_id?: number;
    customer_email?: string;
  };
};

function expectedId(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function safeLicenseApiUrl(): string {
  const configured = process.env.LEMONSQUEEZY_LICENSE_API_URL?.trim();
  if (!configured) return "https://api.lemonsqueezy.com/v1/licenses/validate";
  const parsed = new URL(configured);
  if (process.env.NODE_ENV !== "test" && (parsed.protocol !== "https:" || parsed.hostname !== "api.lemonsqueezy.com")) {
    throw new Error("LEMONSQUEEZY_LICENSE_API_URL must use the official HTTPS API host.");
  }
  return parsed.toString();
}

export async function handleLicenseExchange(req: Request, res: ExpressResponse): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const lemonLicenseKey = typeof body?.licenseKey === "string" ? body.licenseKey.trim() : "";
  const customerEmail = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!lemonLicenseKey) {
    res.status(400).json({ ok: false, error: "licenseKey is required." });
    return;
  }

  const productId = expectedId(process.env.LEMONSQUEEZY_PRODUCT_ID);
  const variantId = expectedId(process.env.LEMONSQUEEZY_VARIANT_ID);
  const privateKeyPath = process.env.AUTO_DOC_LICENSE_PRIVATE_KEY_PATH?.trim();
  if (!productId || !privateKeyPath) {
    res.status(503).json({ ok: false, error: "License activation is not configured." });
    return;
  }

  let lemonResponse: globalThis.Response;
  try {
    lemonResponse = await fetch(safeLicenseApiUrl(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ license_key: lemonLicenseKey }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    res.status(502).json({ ok: false, error: "Lemon Squeezy license validation is unavailable." });
    return;
  }

  let validation: LemonLicenseResponse;
  try {
    validation = (await lemonResponse.json()) as LemonLicenseResponse;
  } catch {
    res.status(502).json({ ok: false, error: "Lemon Squeezy returned an invalid response." });
    return;
  }

  if (!lemonResponse.ok || !validation.valid || validation.license_key?.status === "expired" || validation.license_key?.status === "disabled") {
    res.status(401).json({ ok: false, error: "The Lemon Squeezy license key is not active." });
    return;
  }

  if (String(validation.meta?.product_id ?? "") !== productId) {
    res.status(403).json({ ok: false, error: "The license key does not belong to Auto-Doc MCP." });
    return;
  }
  if (variantId && String(validation.meta?.variant_id ?? "") !== variantId) {
    res.status(403).json({ ok: false, error: "The license key is for a different Auto-Doc MCP plan." });
    return;
  }

  const verifiedEmail = validation.meta?.customer_email?.trim().toLowerCase() ?? "";
  if (customerEmail && verifiedEmail !== customerEmail) {
    res.status(403).json({ ok: false, error: "The purchase email does not match this license key." });
    return;
  }
  if (!verifiedEmail) {
    res.status(502).json({ ok: false, error: "Lemon Squeezy did not return a customer identity." });
    return;
  }

  try {
    const licenseKey = await generateLicenseJwt({ subscriberEmail: verifiedEmail, privateKeyPath });
    res.status(200).json({ ok: true, licenseKey, expiresInDays: 30 });
  } catch {
    res.status(503).json({ ok: false, error: "The license signing key is unavailable." });
  }
}
