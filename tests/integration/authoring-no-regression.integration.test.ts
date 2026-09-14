import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { authorManualSection } from "../../src/lib/manual-author.js";

const runtimeSourceFiles = [
  "src/lib/manual-author.ts",
  "src/orchestrator/auto-doc-orchestrator.ts",
  "src/tools/analyze-documentation-candidate.ts",
  "src/providers/factory.ts",
  "src/providers/openai.ts",
];

describe("authoring-no-regression", () => {
  it("does not introduce runtime TypeScript suppression escapes in the reconnected path", async () => {
    const contents = await Promise.all(runtimeSourceFiles.map((file) => readFile(file, "utf8")));
    const combined = contents.join("\n");
    expect(combined).not.toMatch(/@ts-nocheck|@ts-ignore|\sas\s+any\b/);
  });

  it("redacts secrets from provider-authored manual content", async () => {
    const section = await authorManualSection({
      audience: "User",
      entryType: "User Guide",
      featureName: "Secret Redaction",
      summary: "Provider prose should be redacted.",
      filesChanged: [],
      providerNarrative: {
        providerUsed: "test-provider",
        userGuide: {
          summary: "Use the workflow with NOTION_TOKEN=secret_value_that_must_not_leak.",
          steps: ["Paste authorization: Bearer very-secret-token-value into the wrong place."],
          expectedOutcome: "The manual shows safe redacted values.",
          possibleErrors: ["Do not expose OPENROUTER_API_KEY=secret_openrouter_value."],
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
    expect(section.body).not.toContain("secret_value_that_must_not_leak");
    expect(section.body).not.toContain("very-secret-token-value");
    expect(section.body).not.toContain("secret_openrouter_value");
  });
});
