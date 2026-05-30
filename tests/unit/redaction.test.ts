import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/lib/redaction.js";

describe("redactSecrets", () => {
  it("redacts common secret assignments", () => {
    const input = "NOTION_TOKEN=secret_abc\nOPENAI_API_KEY=sk-test\nnormal=value";
    expect(redactSecrets(input)).toContain("NOTION_TOKEN=[REDACTED]");
    expect(redactSecrets(input)).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redactSecrets(input)).toContain("normal=value");
  });

  it("redacts headers, JSON secret fields, bearer tokens, query params, and private key blocks", () => {
    const input = [
      "Authorization: Bearer sk-super-secret-token",
      '{"apiKey":"abc123","nested":{"access_token":"zxy987"}}',
      "curl https://example.test?token=abc&mode=full",
      "-----BEGIN PRIVATE KEY-----\nline1\nline2\n-----END PRIVATE KEY-----",
    ].join("\n");

    const redacted = redactSecrets(input);
    expect(redacted).toContain("Authorization: [REDACTED]");
    expect(redacted).toContain('"apiKey":"[REDACTED]"');
    expect(redacted).toContain('"access_token":"[REDACTED]"');
    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).toContain("[REDACTED_PRIVATE_KEY_BLOCK]");
    expect(redacted).not.toContain("sk-super-secret-token");
    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("zxy987");
  });

  it("redacts common provider-specific secret formats", () => {
    // Keep Twilio SID format coverage without a single static secret-like literal.
    const twilioSid = "AC1234567890abcdef" + "1234567890abcdef";
    const input = [
      "aws=AKIA1234567890ABCDEF",
      "github=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "stripe=sk_live_1234567890abcdef1234",
      `twilio=${twilioSid}`,
    ].join("\n");

    const redacted = redactSecrets(input);

    expect(redacted).toContain("[REDACTED_AWS_KEY]");
    expect(redacted).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(redacted).toContain("[REDACTED_STRIPE_KEY]");
    expect(redacted).toContain("[REDACTED_TWILIO_KEY]");
  });
});
