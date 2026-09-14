import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { authorManualSection } from "../../src/lib/manual-author.js";

describe("authoring-b-no-regression", () => {
  it("does not add TypeScript suppression escapes in runtime authoring/provider files", async () => {
    const files = [
      "src/lib/manual-author.ts",
      "src/providers/base.ts",
      "src/providers/factory.ts",
      "src/providers/openai.ts",
      "src/providers/ollama.ts",
      "src/providers/anthropic.ts",
    ];
    const combined = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(combined).not.toMatch(/@ts-nocheck|@ts-ignore|\sas\s+any\b/);
  });

  it("redacts secrets even when Tier 1 provider prose contains them", async () => {
    const section = await authorManualSection({
      audience: "User",
      entryType: "User Guide",
      featureName: "Redaction",
      summary: "summary",
      filesChanged: [],
      providerNarrative: {
        providerUsed: "test-provider",
        userGuide: {
          summary: "Use NOTION_TOKEN=secret_value in docs should redact.",
          steps: ["Never paste authorization: Bearer super-secret-value-here."],
          expectedOutcome: "Secrets are redacted.",
          possibleErrors: ["OPENROUTER_API_KEY=secret_openrouter_value"],
        },
        adminGuide: {
          configRequired: [],
          endpointsAffected: [],
          envVarsRequired: [],
          verificationSteps: [],
          troubleshooting: [],
        },
      },
    });

    expect(section.body).toContain("[REDACTED]");
    expect(section.body).not.toContain("secret_value");
    expect(section.body).not.toContain("super-secret-value-here");
    expect(section.body).not.toContain("secret_openrouter_value");
  });
});
