import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("test environment isolation", () => {
  it("does not auto-load the workstation .env during tests", async () => {
    const source = await readFile("src/config.ts", "utf8");
    expect(source).toContain('if (process.env.NODE_ENV !== "test")');
    expect(source).toContain("dotenvConfig();");
  });
});
