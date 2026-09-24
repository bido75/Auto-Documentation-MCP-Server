import { createVerify } from "node:crypto";
import { readFileSync } from "node:fs";

export type LicensePlan = "maintenance";

export interface LicensePayload {
  sub: string;
  iat: number;
  exp: number;
  plan: LicensePlan;
  activations: number;
  store: "auto-doc-mcp";
}

export type LicenseStatus =
  | {
      valid: true;
      plan: LicensePlan;
      subject: string;
      expiresAt: Date;
      gracePeriodDaysLeft?: number;
    }
  | {
      valid: false;
      reason:
        | "no_license"
        | "missing_public_key"
        | "invalid_format"
        | "invalid_signature"
        | "invalid_payload"
        | "wrong_store"
        | "wrong_plan"
        | "expired"
        | "parse_error";
      expiresAt?: Date;
    };

const CACHE_TTL_MS = 60 * 60 * 1000;
const GRACE_PERIOD_DAYS = 7;
const LICENSE_STORE = "auto-doc-mcp";
const LICENSE_PLAN: LicensePlan = "maintenance";
const DEFAULT_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0O1j+8+kkz07DkZWmXE/
gjHo/FbiD/FlceMp+IMkcbDf/NHjiVXIrxFwVgcoqtC6++q9GEub/ZdnzIgdMyJ7
j608IzXJlvAqBEU8W2u59nstA6lmzEvRA2ePqH3/bqQw4qCf1SBYuN47WTqKlg1h
eNTG6Lckprw7A6nWDEYcRj/01X2rB59sXcFMj19OrheYW/ifz0sUDcHjzFDo6INe
0AeUvncCpizheKcdjl5299d8oODDtDWW5YhmU6eonY6OeBf0HzvBmDOSw1/Qhh/C
7yYOvS5lPikswTBSnfHVl7N9J3oLgJ/N8CqXd56ExAe8CzY1pXb9l0F7NjHEPdBX
EQIDAQAB
-----END PUBLIC KEY-----`;

const FREE_TOOLS = new Set([
  "initialize_project_manual",
  "capture_development_event",
  "get_git_diff_summary",
  "get_documentation_status",
  "configure_ai_provider",
  "get_runner_failure_triage_metadata",
  "get_runner_health_summary",
  "get_runner_release_automation_status",
  "health_check",
  "set_runner_failure_triage_metadata",
]);

let cachedStatus: LicenseStatus | null = null;
let cacheTime = 0;

function decodeBase64Url(segment: string): Buffer {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
}

function readLicensePublicKey(env: NodeJS.ProcessEnv): string | null {
  const inline = env.AUTO_DOC_LICENSE_PUBLIC_KEY?.trim();
  if (inline) {
    return inline.replace(/\\n/g, "\n");
  }

  const filePath = env.AUTO_DOC_LICENSE_PUBLIC_KEY_FILE?.trim();
  if (filePath) {
    return readFileSync(filePath, "utf8");
  }

  return DEFAULT_LICENSE_PUBLIC_KEY;
}

function parsePayload(payloadSegment: string): LicensePayload | null {
  try {
    const parsed = JSON.parse(decodeBase64Url(payloadSegment).toString("utf8")) as Partial<LicensePayload>;
    if (
      typeof parsed.sub !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number" ||
      typeof parsed.plan !== "string" ||
      typeof parsed.activations !== "number" ||
      typeof parsed.store !== "string"
    ) {
      return null;
    }

    return parsed as LicensePayload;
  } catch {
    return null;
  }
}

function readConfiguredProviderType(env: NodeJS.ProcessEnv): string {
  return env.AI_PROVIDER_TYPE?.trim().toLowerCase() || "bifrost";
}

export function resetLicenseCacheForTests(): void {
  cachedStatus = null;
  cacheTime = 0;
}

export function getLicenseStatus(env: NodeJS.ProcessEnv = process.env, now = new Date()): LicenseStatus {
  if (env === process.env && cachedStatus && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedStatus;
  }

  const key = env.AUTO_DOC_LICENSE_KEY?.trim();
  if (!key) {
    const status: LicenseStatus = { valid: false, reason: "no_license" };
    if (env === process.env) {
      cachedStatus = status;
      cacheTime = Date.now();
    }
    return status;
  }

  const publicKey = readLicensePublicKey(env);
  if (!publicKey) {
    const status: LicenseStatus = { valid: false, reason: "missing_public_key" };
    if (env === process.env) {
      cachedStatus = status;
      cacheTime = Date.now();
    }
    return status;
  }

  try {
    const [header, payloadSegment, signatureSegment, ...extra] = key.split(".");
    if (!header || !payloadSegment || !signatureSegment || extra.length > 0) {
      return { valid: false, reason: "invalid_format" };
    }

    const payload = parsePayload(payloadSegment);
    if (!payload) {
      return { valid: false, reason: "invalid_payload" };
    }

    if (payload.store !== LICENSE_STORE) {
      return { valid: false, reason: "wrong_store" };
    }

    if (payload.plan !== LICENSE_PLAN) {
      return { valid: false, reason: "wrong_plan" };
    }

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payloadSegment}`);
    verifier.end();
    const signatureValid = verifier.verify(publicKey, decodeBase64Url(signatureSegment));
    if (!signatureValid) {
      return { valid: false, reason: "invalid_signature" };
    }

    const expiresAt = new Date(payload.exp * 1000);
    const graceEndsAt = new Date((payload.exp + GRACE_PERIOD_DAYS * 24 * 60 * 60) * 1000);
    if (now.getTime() > graceEndsAt.getTime()) {
      return { valid: false, reason: "expired", expiresAt };
    }

    if (now.getTime() > expiresAt.getTime()) {
      const gracePeriodDaysLeft = Math.max(0, Math.ceil((graceEndsAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
      return {
        valid: true,
        plan: payload.plan,
        subject: payload.sub,
        expiresAt,
        gracePeriodDaysLeft,
      };
    }

    const status: LicenseStatus = {
      valid: true,
      plan: payload.plan,
      subject: payload.sub,
      expiresAt,
    };
    if (env === process.env) {
      cachedStatus = status;
      cacheTime = Date.now();
    }
    return status;
  } catch {
    return { valid: false, reason: "parse_error" };
  }
}

export function requiresLicense(toolName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (FREE_TOOLS.has(toolName)) {
    return false;
  }

  if (toolName === "analyze_documentation_candidate") {
    return readConfiguredProviderType(env) !== "deterministic";
  }

  return true;
}

export function buildLicenseNagMessage(input?: { toolName?: string; reason?: string }): string {
  const toolLine = input?.toolName ? `Tool: ${input.toolName}` : "Tool: advanced Auto-Doc feature";
  const reasonLine = input?.reason ? `Reason: ${input.reason}` : "Reason: no active maintenance license";
  return [
    "Auto-Doc MCP license required.",
    toolLine,
    reasonLine,
    "",
    "Core tools remain free: initialize_project_manual, capture_development_event, get_git_diff_summary, get_documentation_status, configure_ai_provider, and health/status tools.",
    "Licensed tools include AI-backed analysis, probing, synthesis, humanizer, health score, webhooks, packaging, and exports.",
    "",
    "Plan: $3/month maintenance license. You bring your own Notion token and AI provider key.",
    "Add AUTO_DOC_LICENSE_KEY to your environment or .env file.",
  ].join("\n");
}
