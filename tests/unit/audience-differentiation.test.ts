/**
 * Acceptance: criterion 2 - user vs admin content genuinely differs.
 * DO NOT DELETE/SKIP.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { authorManualSection } from "../../src/lib/manual-author.js";

async function createRepo() {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-audience-"));
  await writeFile(
    join(repoPath, "README.md"),
    [
      "# Auto-Documentation MCP Server",
      "Use stdio locally with `node build/src/index.js`.",
      "Run bridge mode with `node build/src/cli/index.js bridge` and check `GET /health`.",
      "Configure runner mode with AUTO_DOC_RUNNER_PROJECT_ID and AUTO_DOC_RUNNER_REPO_PATH.",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(repoPath, ".env.example"),
    ["NOTION_TOKEN=ntn_do_not_leak", "STATE_ENCRYPTION_KEY=replace-me", "AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK=false"].join("\n"),
    "utf8",
  );
  return repoPath;
}

async function authorBoth() {
  const repoPath = await createRepo();
  const common = {
    featureName: "HTTP Bridge and Runner Operations",
    summary: "HTTP/SSE bridge and continuous runner deployment configuration.",
    diffSummary: "README documents bridge start command, health endpoint, runner env vars, and secret requirements.",
    filesChanged: ["README.md", ".env.example"],
    repoPath,
  };
  const user = await authorManualSection({ ...common, audience: "User", entryType: "User Guide" });
  const admin = await authorManualSection({ ...common, audience: "Admin", entryType: "Admin Guide" });
  return { user, admin };
}

describe("audience-differentiation", () => {
  it("user section teaches USE (install/configure/operate common workflows)", async () => {
    const { user } = await authorBoth();

    expect(user.body).toContain("## How to use it");
    expect(user.body).toMatch(/call MCP tools|use the MCP server|open your MCP client/i);
  });

  it("admin section teaches SETUP/OPERATION (requirements, deploy, secrets, runner/bridge)", async () => {
    const { admin } = await authorBoth();

    expect(admin.body).toContain("## Operations setup");
    expect(admin.body).toContain("STATE_ENCRYPTION_KEY");
    expect(admin.body).toContain("node build/src/cli/index.js bridge");
    expect(admin.body).toContain("GET /health");
  });

  it("admin-only concerns (secrets, deployment, requirements) appear in admin, not user", async () => {
    const { user, admin } = await authorBoth();

    expect(admin.body).toContain("AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK");
    expect(admin.body).toContain("runner mode");
    expect(user.body).not.toContain("AUTO_DOC_ENABLE_ENV_TOKEN_FALLBACK");
  });

  it("the two sections for the same feature differ in content (not duplicated)", async () => {
    const { user, admin } = await authorBoth();

    expect(user.body).not.toBe(admin.body);
    expect(admin.body.length).toBeGreaterThan(user.body.length * 0.8);
  });
});
