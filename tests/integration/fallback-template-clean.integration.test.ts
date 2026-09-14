import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authorManualSection } from "../../src/lib/manual-author.js";

async function createRepoFixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-fallback-template-"));
  await writeFile(
    join(repoPath, "README.md"),
    [
      "# Auto-Documentation MCP Server",
      "The bridge exposes `GET /health` and accepts `POST /messages` for MCP JSON-RPC.",
      "```bash",
      "npm ci",
      "```",
    ].join("\n"),
  );
  await writeFile(
    join(repoPath, "package.json"),
    JSON.stringify({
      scripts: {
        start: "node build/src/index.js",
        dev: "tsx src/index.ts",
        build: "tsc",
      },
    }),
  );
  await writeFile(join(repoPath, ".env.example"), "NOTION_TOKEN=\nSTATE_ENCRYPTION_KEY=\nAUTO_DOC_HTTP_PORT=3000\n");
  await writeFile(
    join(repoPath, "docker-compose.yml"),
    "services:\n  app:\n    environment:\n      AUTO_DOC_RUNNER_PROJECT_ID: ${AUTO_DOC_RUNNER_PROJECT_ID:-}\n",
  );
  return repoPath;
}

describe("fallback-template-clean", () => {
  it("provider-off fallback still authors a clean User section without source dumps or npm-ci startup", async () => {
    const repoPath = await createRepoFixture();
    const section = await authorManualSection({
      audience: "User",
      entryType: "User Guide",
      featureName: "Core MCP Tool Pipeline",
      summary: "Core workflow for using Auto-Doc.",
      diffSummary: "Repo evidence excerpt:\nGET POST MCP HTTP RPC",
      filesChanged: ["README.md"],
      repoPath,
    });

    expect(section.body).toContain("## Overview");
    expect(section.body).toContain("## Step-by-step setup");
    expect(section.body).not.toContain("Source context:");
    expect(section.body).not.toContain("Repo evidence excerpt:");
    expect(section.body).not.toContain("bash\nnpm ci");
    expect(section.body).not.toContain("Start the MCP server with `npm ci`");
    expect(section.body).toMatch(/npm run (start|dev)|node build\/src\/index\.js/);
  });

  it("provider-off fallback Admin config reference lists only real env vars with descriptions", async () => {
    const repoPath = await createRepoFixture();
    const section = await authorManualSection({
      audience: "Admin",
      entryType: "Admin Guide",
      featureName: "Deployment Configuration",
      summary: "Admin workflow for deploying Auto-Doc.",
      diffSummary: "Repo evidence excerpt:\nGET POST MCP HTTP RPC",
      filesChanged: ["README.md", ".env.example", "docker-compose.yml"],
      repoPath,
    });

    expect(section.body).toContain("## Configuration reference");
    expect(section.body).toContain("NOTION_TOKEN:");
    expect(section.body).toContain("STATE_ENCRYPTION_KEY:");
    expect(section.body).toContain("AUTO_DOC_HTTP_PORT:");
    expect(section.body).not.toMatch(/^- (GET|POST|MCP|HTTP|RPC)$/m);
    expect(section.body).not.toContain("Source context:");
  });
});
