import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/lib/redaction.js";

describe("redactSecrets", () => {
  it("redacts common secret assignments", () => {
    const input = "NOTION_TOKEN=secret_abc\nOPENAI_API_KEY=sk-test\nnormal=value";
    expect(redactSecrets(input)).toContain("NOTION_TOKEN=[REDACTED]");
    expect(redactSecrets(input)).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redactSecrets(input)).toContain("normal=value");
  });

  it("redacts secret-bearing headers, JSON values, query params, and bearer tokens", () => {
    const input = [
      "authorization: Bearer very-secret-token-value",
      '{"apiKey":"abc123","safe":"ok"}',
      "https://example.com/callback?token=abc123&x=1",
      "x-api-key: key-123",
    ].join("\n");

    const result = redactSecrets(input);
    expect(result).toContain("authorization: [REDACTED]");
    expect(result).toContain('"apiKey":"[REDACTED]"');
    expect(result).toContain("token=[REDACTED]");
    expect(result).toContain("x-api-key: [REDACTED]");
    expect(result).not.toContain("very-secret-token-value");
  });

  it("redacts private key blocks", () => {
    const input = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    expect(redactSecrets(input)).toContain("[REDACTED_PRIVATE_KEY_BLOCK]");
  });
});
