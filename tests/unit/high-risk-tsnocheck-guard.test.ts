import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const guardedFiles = [
  "src/lib/analyzer.ts",
  "src/installer/token-store.ts",
  "src/tools/run-autonomous-documentation-trigger.ts",
  "src/tools/run-release-documentation-pipeline.ts",
];

describe("high-risk TypeScript suppression guard", () => {
  it("keeps workflow and secret-storage files free of file-wide TypeScript suppression", async () => {
    const contents = await Promise.all(guardedFiles.map(async (file) => [file, await readFile(file, "utf8")] as const));
    const suppressed = contents
      .filter(([, content]) => content.includes("@ts-nocheck"))
      .map(([file]) => file);

    expect(suppressed).toEqual([]);
  });
});
