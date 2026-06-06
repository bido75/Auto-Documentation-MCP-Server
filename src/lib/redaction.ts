const SECRET_NAME = "(?:token|secret|password|api[_-]?key|private[_-]?key|access[_-]?token|authorization)";
const SECRET_ASSIGNMENT = new RegExp(`\\b([A-Z0-9_]*${SECRET_NAME}[A-Z0-9_]*)\\s*=\\s*([\"']?)([^\\s\"']+)\\2`, "gi");
const SECRET_JSON_PAIR = new RegExp(`(\"[^\"]*${SECRET_NAME}[^\"]*\"\\s*:\\s*)(\"[^\"]*\"|'[^']*'|[^,\\s}]+)`, "gi");
const SECRET_HEADER = /\b(authorization|x-api-key|api-key)\s*:\s*([^\r\n]+)/gi;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const AWS_ACCESS_KEY = /\bA(?:KI|SI)A[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi;
const STRIPE_KEY = /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gi;
const TWILIO_KEY = /\b(?:AC|SK)[a-fA-F0-9]{32}\b/g;
const SECRET_QUERY_PARAM = new RegExp(`([?&](?:${SECRET_NAME})=)([^&\\s]+)`, "gi");
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi;

export function redactSecrets(input: string): string {
  let redacted = input;

  redacted = redacted.replace(PRIVATE_KEY_BLOCK, "[REDACTED_PRIVATE_KEY_BLOCK]");
  redacted = redacted.replace(SECRET_ASSIGNMENT, (_match, key) => `${String(key)}=[REDACTED]`);
  redacted = redacted.replace(SECRET_JSON_PAIR, (_match, prefix) => `${String(prefix)}\"[REDACTED]\"`);
  redacted = redacted.replace(SECRET_HEADER, (_match, key) => `${String(key)}: [REDACTED]`);
  redacted = redacted.replace(BEARER_TOKEN, "Bearer [REDACTED]");
  redacted = redacted.replace(AWS_ACCESS_KEY, "[REDACTED_AWS_KEY]");
  redacted = redacted.replace(GITHUB_TOKEN, "[REDACTED_GITHUB_TOKEN]");
  redacted = redacted.replace(STRIPE_KEY, "[REDACTED_STRIPE_KEY]");
  redacted = redacted.replace(TWILIO_KEY, "[REDACTED_TWILIO_KEY]");
  redacted = redacted.replace(SECRET_QUERY_PARAM, (_match, prefix) => `${String(prefix)}[REDACTED]`);

  return redacted;
}
