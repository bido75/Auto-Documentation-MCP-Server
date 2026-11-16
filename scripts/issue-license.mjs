#!/usr/bin/env node
import { createSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function usage() {
  console.error("Usage: node scripts/issue-license.mjs <email> <months> [--env-file <path>]");
  process.exit(1);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const email = process.argv[2]?.trim();
const months = Number(process.argv[3]);
if (!email || !email.includes("@") || !Number.isInteger(months) || months < 1 || months > 120) usage();

const privateKeyPath = process.env.AUTO_DOC_LICENSE_PRIVATE_KEY_PATH?.trim() ||
  (process.platform === "win32"
    ? "C:\\ProgramData\\auto-doc-mcp\\license-private.pem"
    : "/etc/auto-doc-mcp/license-private.pem");
const privateKey = readFileSync(privateKeyPath, "utf8");
const nowSeconds = Math.floor(Date.now() / 1000);
const expiresAt = nowSeconds + months * 30 * 24 * 60 * 60;
const encodeJson = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const header = encodeJson({ alg: "RS256", typ: "JWT" });
const payload = encodeJson({
  sub: email,
  iat: nowSeconds,
  exp: expiresAt,
  plan: "maintenance",
  activations: 3,
  store: "auto-doc-mcp",
});
const signer = createSign("RSA-SHA256");
signer.update(`${header}.${payload}`);
signer.end();
const token = `${header}.${payload}.${signer.sign(privateKey, "base64url")}`;
const envFile = argumentValue("--env-file");

if (envFile) {
  const existing = readFileSync(envFile, "utf8");
  const lines = existing.split(/\r?\n/).filter((line) => !line.startsWith("AUTO_DOC_LICENSE_KEY="));
  lines.push(`AUTO_DOC_LICENSE_KEY=${token}`);
  writeFileSync(envFile, `${lines.filter(Boolean).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

console.log(JSON.stringify({
  ok: true,
  subject: email,
  months,
  expiresAt: new Date(expiresAt * 1000).toISOString(),
  envFileUpdated: envFile ?? null,
}));
