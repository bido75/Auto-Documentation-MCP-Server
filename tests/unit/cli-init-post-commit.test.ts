import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { describe, expect, it, vi } from "vitest";
import { runInit } from "../../src/cli/commands/init.js";

describe("init --post-commit-hook", () => {
  it("installs from a nested directory without running interactive initialization", async () => {
    const repo = await mkdtemp(join(tmpdir(), "auto-doc-init-hook-"));
    await simpleGit(repo).init();
    const nested = join(repo, "packages", "app");
    await mkdir(nested, { recursive: true });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runInit(["--post-commit-hook"], { cwd: nested });

    const hook = await readFile(join(repo, ".git", "hooks", "post-commit"), "utf8");
    expect(hook).toContain("build/src/index.js");
    expect(stderr.mock.calls.flat().join(" ")).toContain("Post-commit hook installed");
    stderr.mockRestore();
  });
});
