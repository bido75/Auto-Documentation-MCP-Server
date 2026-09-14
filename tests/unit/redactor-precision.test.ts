import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/lib/redaction.js";

describe("redactor-precision", () => {
  it("does not redact non-secret boolean or enum config assignments even when the variable name contains token", () => {
    const input = [
      "AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=true",
      "AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE=false",
      "AI_PROVIDER_TYPE=cloud-openai",
      "PUBLISHING_MODE=Automatic",
    ].join("\n");

    const result = redactSecrets(input);

    expect(result).toContain("AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=true");
    expect(result).toContain("AUTO_DOC_ALLOW_UNAUTHENTICATED_SSE=false");
    expect(result).toContain("AI_PROVIDER_TYPE=cloud-openai");
    expect(result).toContain("PUBLISHING_MODE=Automatic");
    expect(result).not.toContain("AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=[REDACTED]");
  });

  it("still redacts real secret assignments, JSON values, query params, and bearer tokens", () => {
    const input = [
      "NOTION_TOKEN=secret_value_1234567890",
      "OPENROUTER_API_KEY=sk-or-v1-secretvalue1234567890",
      '{"apiKey":"sk-secretvalue1234567890"}',
      "https://example.com/callback?access_token=secretvalue1234567890",
      "Authorization: Bearer secretvalue1234567890",
    ].join("\n");

    const result = redactSecrets(input);

    expect(result).toContain("NOTION_TOKEN=[REDACTED]");
    expect(result).toContain("OPENROUTER_API_KEY=[REDACTED]");
    expect(result).toContain('"apiKey":"[REDACTED]"');
    expect(result).toContain("?access_token=[REDACTED]");
    expect(result).toContain("Authorization: [REDACTED]");
  });

  it("repairs already-redacted known boolean flags emitted by provider prose", () => {
    const input = "Temporarily enable AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=[REDACTED] for trusted local development.";

    expect(redactSecrets(input)).toContain("AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=true");
  });
});
