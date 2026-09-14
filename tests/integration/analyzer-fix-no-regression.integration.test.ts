import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const RUNTIME_FILES = [
  "src/lib/analyzer.ts",
  "src/lib/guardrail.ts",
  "src/tools/analyze-documentation-candidate.ts",
  "src/orchestrator/auto-doc-orchestrator.ts",
  "src/lib/manual-assembler.ts",
  "src/tools/assemble-manual.ts",
  "src/tools/package-manual.ts",
  "src/tools/export-manual-markdown.ts",
  "src/tools/export-manual-pdf.ts",
  "src/tools/export-help-center-content.ts",
  "src/tools/sync-manual-to-local-docs.ts",
];

describe("analyzer-fix-no-regression", () => {
  it("does not add type suppression escapes in analyzer validation or empty-output runtime paths", async () => {
    for (const file of RUNTIME_FILES) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/@ts-nocheck|@ts-ignore|\bas\s+any\b/);
    }
  });
});
