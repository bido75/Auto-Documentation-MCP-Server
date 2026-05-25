import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/lib/redaction.js";

describe("redactSecrets", () => {
  it("redacts common secret assignments", () => {
    const input = "NOTION_TOKEN=secret_abc\nOPENAI_API_KEY=sk-test\nnormal=value";
    expect(redactSecrets(input)).toContain("NOTION_TOKEN=[REDACTED]");
    expect(redactSecrets(input)).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redactSecrets(input)).toContain("normal=value");
  });
});
