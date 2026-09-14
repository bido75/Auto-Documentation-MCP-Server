import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const runtimeFiles = [
  "src/lib/manual-assembler.ts",
  "src/lib/redaction.ts",
  "src/tools/assemble-manual.ts",
  "src/tools/export-manual-markdown.ts",
  "src/tools/export-manual-pdf.ts",
  "src/tools/package-manual.ts",
  "src/tools/sync-manual-to-local-docs.ts",
];

describe("assembler-no-regression", () => {
  it("adds no runtime type suppressions while fixing assembly", () => {
    for (const file of runtimeFiles) {
      const text = readFileSync(join(process.cwd(), file), "utf8");
      expect(text, file).not.toMatch(/@ts-nocheck|@ts-ignore|\bas any\b/);
    }
  });
});
