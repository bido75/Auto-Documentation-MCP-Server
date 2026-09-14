/**
 * Acceptance: criterion 1 - authoring produces INSTRUCTION, not an evidence dump.
 * The single most important test: proves the core defect is fixed.
 * Must FAIL if author stage is swapped for the old reformat-evidence behavior. DO NOT DELETE/SKIP.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authorManualSection } from "../../src/lib/manual-author.js";

async function createSubjectRepo() {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-authoring-"));
  await writeFile(
    join(repoPath, "README.md"),
    [
      "# Auto-Documentation MCP Server",
      "Production TypeScript MCP server that captures development signals and builds user/admin manuals in Notion.",
      "Use stdio locally with `node build/src/index.js`.",
      "Use the HTTP bridge with `node build/src/cli/index.js bridge`.",
      "Check the bridge with `GET /health`.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repoPath, "package.json"),
    JSON.stringify({ scripts: { build: "tsc", start: "node build/src/index.js", dev: "tsx src/index.ts" } }, null, 2),
    "utf8",
  );
  await writeFile(
    join(repoPath, ".env.example"),
    ["NOTION_TOKEN=ntn_real_secret_should_not_leak", "STATE_ENCRYPTION_KEY=change-me", "AUTO_DOC_HTTP_PORT=3000"].join("\n"),
    "utf8",
  );
  return repoPath;
}

async function authorUserSection() {
  const repoPath = await createSubjectRepo();
  return authorManualSection({
    audience: "User",
    entryType: "User Guide",
    featureName: "Core MCP Tool Pipeline",
    summary: "Core MCP tool pipeline workflow for initializing manuals and exporting documentation.",
    diffSummary: "README describes stdio usage, bridge usage, build scripts, and health checks.",
    filesChanged: ["README.md", "package.json", ".env.example"],
    repoPath,
  });
}

describe("authoring-produces-instruction", () => {
  it("authored section contains an Overview/Introduction heading with plain-language framing", async () => {
    const section = await authorUserSection();

    expect(section.body).toMatch(/## Overview|## Introduction/);
    expect(section.body).toContain("Auto-Documentation MCP Server");
  });

  it("authored section contains a Prerequisites list", async () => {
    const section = await authorUserSection();

    expect(section.body).toMatch(/## Prerequisites/);
    expect(section.body).toMatch(/- Node\.js/);
    expect(section.body).toMatch(/- Notion integration token/);
  });

  it("authored section contains NUMBERED step-by-step instructions with expected results", async () => {
    const section = await authorUserSection();

    expect(section.body).toMatch(/## Step-by-step setup/);
    expect(section.body).toMatch(/1\. Run `npm install`/);
    expect(section.body).toMatch(/2\. Run `npm run build`/);
    expect(section.body).toMatch(/Expected result:/);
  });

  it('authored section does NOT contain the forbidden "Repo evidence excerpt:" + file-list shape', async () => {
    const section = await authorUserSection();

    expect(section.body).not.toContain("Repo evidence excerpt:");
    expect(section.body).not.toMatch(/Files changed:\s*\n- /);
  });

  it("authoring reads real repo source (README/config/CLI), not just the commit summary", async () => {
    const section = await authorUserSection();

    expect(section.sourceFilesRead).toEqual(expect.arrayContaining(["README.md", "package.json", ".env.example"]));
    expect(section.body).toContain("node build/src/index.js");
    expect(section.body).toContain("AUTO_DOC_HTTP_PORT");
    expect(section.body).not.toContain("ntn_real_secret_should_not_leak");
  });
});
