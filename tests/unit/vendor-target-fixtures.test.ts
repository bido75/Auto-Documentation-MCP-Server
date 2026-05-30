import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_CONFIGS } from "../../src/installer/universal-config-writer";

type VendorTargetFixture = {
  tool: string;
  status: "supported" | "unsupported_raw_config_target";
  sourceUrls: string[];
  documentedConfigPath?: string;
  documentedWorkspacePath?: string;
  format?: string;
  example?: unknown;
  notes: string;
};

const FIXTURE_DIR = join(process.cwd(), "tests", "fixtures", "vendor-targets");

async function loadFixtures(): Promise<VendorTargetFixture[]> {
  const entries = await readdir(FIXTURE_DIR);
  const fixtures = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => JSON.parse(await readFile(join(FIXTURE_DIR, entry), "utf8")) as VendorTargetFixture),
  );

  fixtures.sort((left, right) => left.tool.localeCompare(right.tool));
  return fixtures;
}

describe("vendor target fixtures", () => {
  it("tracks each previously experimental vendor target with an authoritative docs-backed fixture", async () => {
    const fixtures = await loadFixtures();
    expect(fixtures.map((fixture) => fixture.tool)).toEqual([
      "Amazon Q Developer",
      "Nova",
      "Pieces for Developers",
      "Sourcegraph Cody",
      "Sublime Text",
    ]);
    expect(fixtures.every((fixture) => fixture.sourceUrls.length > 0)).toBe(true);
  });

  it("keeps only vendor-documented targets in the active writer list", async () => {
    const fixtures = await loadFixtures();

    const supported = fixtures.filter((fixture) => fixture.status === "supported");
    const unsupported = fixtures.filter((fixture) => fixture.status === "unsupported_raw_config_target");

    for (const fixture of supported) {
      expect(TOOL_CONFIGS.find((config) => config.tool === fixture.tool)).toEqual(
        expect.objectContaining({
          tool: fixture.tool,
          format: fixture.format,
        }),
      );
    }

    for (const fixture of unsupported) {
      expect(TOOL_CONFIGS.find((config) => config.tool === fixture.tool)).toBeUndefined();
    }
  });
});