import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Request, Response } from "express";

const DEFAULT_LICENSE_MONTHS = 1;

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function readWebhookSignature(req: Request): string {
  return req.header("x-signature")?.trim() ?? "";
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature || !secret) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeStringEqual(expected, signature);
}

async function generateLicenseJwt(input: {
  subscriberEmail: string;
  privateKeyPath: string;
  planMonths?: number;
  now?: Date;
}): Promise<string> {
  const privateKey = await readFile(input.privateKeyPath, "utf8");
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const planMonths = Math.max(1, input.planMonths ?? DEFAULT_LICENSE_MONTHS);
  const expiresAt = nowSeconds + planMonths * 30 * 24 * 60 * 60;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    sub: input.subscriberEmail,
    iat: nowSeconds,
    exp: expiresAt,
    plan: "maintenance",
    activations: 3,
    store: "auto-doc-mcp",
  });
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  sign.end();
  return `${header}.${payload}.${sign.sign(privateKey, "base64url")}`;
}

function readSubscriberEmail(payload: unknown): string | null {
  const root = payload as Record<string, unknown>;
  const data = root.data as Record<string, unknown> | undefined;
  const attributes = data?.attributes as Record<string, unknown> | undefined;
  const userEmail = attributes?.user_email;
  const customerEmail = attributes?.customer_email;
  const orderEmail = attributes?.email;
  return [userEmail, customerEmail, orderEmail].find((value): value is string => typeof value === "string" && value.includes("@")) ?? null;
}

function readEventName(payload: unknown): string {
  const root = payload as Record<string, unknown>;
  const meta = root.meta as Record<string, unknown> | undefined;
  return typeof meta?.event_name === "string" ? meta.event_name : "";
}

export async function handleLemonsqueezyWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("", "utf8");
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET?.trim() ?? "";
  if (!verifyWebhookSignature(rawBody, readWebhookSignature(req), secret)) {
    res.status(401).json({ ok: false, error: "Invalid Lemon Squeezy webhook signature." });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ ok: false, error: "Invalid Lemon Squeezy webhook JSON." });
    return;
  }

  const eventName = readEventName(payload);
  if (!["subscription_created", "order_created", "license_key_created"].includes(eventName)) {
    res.status(200).json({ ok: true, status: "ignored", eventName });
    return;
  }

  const subscriberEmail = readSubscriberEmail(payload);
  if (!subscriberEmail) {
    res.status(400).json({ ok: false, error: "Missing subscriber email in Lemon Squeezy payload." });
    return;
  }

  const privateKeyPath = process.env.AUTO_DOC_LICENSE_PRIVATE_KEY_PATH?.trim();
  if (!privateKeyPath) {
    res.status(503).json({
      ok: false,
      error: "AUTO_DOC_LICENSE_PRIVATE_KEY_PATH is not configured; license issuance is disabled.",
    });
    return;
  }

  const licenseKey = await generateLicenseJwt({ subscriberEmail, privateKeyPath });
  console.error(`[license] Issued Auto-Doc MCP license for ${subscriberEmail}`);
  res.status(200).json({ ok: true, status: "issued", eventName, licenseKey });
}

export const lemonsqueezyWebhookInternals = {
  generateLicenseJwt,
  verifyWebhookSignature,
};
