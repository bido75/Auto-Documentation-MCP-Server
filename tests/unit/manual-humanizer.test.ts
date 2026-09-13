import { describe, expect, it } from "vitest";
import { composeAssembledManualMarkdown } from "../../src/lib/manual-assembler.js";
import { humanizeManualMarkdown } from "../../src/lib/manual-humanizer.js";

describe("manual humanizer", () => {
  it("removes common AI tells from prose while preserving technical facts", () => {
    const result = humanizeManualMarkdown(
      [
        "# Billing Export",
        "",
        "In this guide, this section explains how to utilize BILLING_EXPORT_BUCKET for invoice exports.",
        "It is important to note that admins must set BILLING_EXPORT_BUCKET before deployment.",
      ].join("\n"),
    );

    expect(result.changed).toBe(true);
    expect(result.text).toContain("use BILLING_EXPORT_BUCKET");
    expect(result.text).toContain("admins must set BILLING_EXPORT_BUCKET");
    expect(result.text).not.toMatch(/In this guide|It is important to note|utilize/i);
    expect(result.metrics.aiPhraseReplacements).toBeGreaterThanOrEqual(3);
  });

  it("normalizes shell code examples without changing non-shell source code", () => {
    const result = humanizeManualMarkdown(
      [
        "Run the setup command:",
        "",
        "```bash",
        "$ bash npm ci   ",
        "powershell npm run build",
        "```",
        "",
        "```ts",
        "const command = 'bash npm ci';   ",
        "```",
      ].join("\n"),
    );

    expect(result.text).toContain("```bash\nnpm ci\nnpm run build\n```");
    expect(result.text).toContain("```ts\nconst command = 'bash npm ci';\n```");
    expect(result.metrics.codeLineChanges).toBeGreaterThanOrEqual(3);
  });

  it("runs through assembled manual composition so packaging and exports use humanized content", () => {
    const markdown = composeAssembledManualMarkdown({
      projectName: "Acme App",
      audience: "user",
      entries: [
        {
          id: "entry_1",
          title: "Billing Export User Guide",
          audience: "User",
          status: "Published",
          body: "In this guide, utilize the export button.\n\n```bash\nbash npm ci\n```",
        },
      ],
    });

    expect(markdown).toContain("use the export button");
    expect(markdown).toContain("```bash\nnpm ci\n```");
    expect(markdown).not.toMatch(/In this guide|utilize|bash npm ci/i);
  });
});
