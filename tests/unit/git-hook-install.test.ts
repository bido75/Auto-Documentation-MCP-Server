import { appendFile, chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { describe, expect, it } from "vitest";
import { installGitHook } from "../../src/git-hook/install.js";

describe("installGitHook", () => {
  it("installs the MCP entrypoint and keeps failures in a repository-local log", async () => {
    const repo = await mkdtemp(join(tmpdir(), "auto-doc-hook-"));
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    const serverPath = "C:\\project\\build\\src\\index.js";

    await installGitHook(repo, serverPath);

    const hookPath = join(repo, ".git", "hooks", "post-commit");
    const hook = await readFile(hookPath, "utf8");
    expect(hook).toContain('SERVER_PATH="C:/project/build/src/index.js"');
    expect(hook).toContain('node "$SERVER_PATH" post-commit >>"$LOG_PATH" 2>&1 &');
    expect(hook).toContain("BEGIN Auto-Doc MCP");
    if (process.platform !== "win32") {
      expect((await stat(hookPath)).mode & 0o111).not.toBe(0);
    }
  });

  it("uses a portable repository-relative entrypoint when the server is inside the repo", async () => {
    const repo = await mkdtemp(join(tmpdir(), "auto-doc-hook-portable-"));
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });

    await installGitHook(repo, join(repo, "build", "src", "index.js"));

    const hook = await readFile(join(repo, ".git", "hooks", "post-commit"), "utf8");
    expect(hook).toContain('SERVER_PATH="$REPO_PATH/build/src/index.js"');
    expect(hook).not.toContain(repo.replace(/\\/g, "/"));
  });

  it("preserves an existing hook and replaces only the Auto-Doc block", async () => {
    const repo = await mkdtemp(join(tmpdir(), "auto-doc-hook-existing-"));
    const hookPath = join(repo, ".git", "hooks", "post-commit");
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(hookPath, "#!/usr/bin/env sh\necho existing\nexit 0\n", "utf8");
    await chmod(hookPath, 0o755);

    await installGitHook(repo, "C:\\one\\index.js");
    await installGitHook(repo, "C:\\two\\index.js");

    const hook = await readFile(hookPath, "utf8");
    expect(hook).toContain("echo existing");
    expect(hook).not.toContain("C:/one/index.js");
    expect(hook).toContain("C:/two/index.js");
    expect(hook.match(/BEGIN Auto-Doc MCP/g)).toHaveLength(1);
    expect(hook.indexOf("BEGIN Auto-Doc MCP")).toBeLessThan(hook.indexOf("echo existing"));
  });

  it("installs into core.hooksPath and runs before an existing early exit", async () => {
    const repo = await mkdtemp(join(tmpdir(), "auto-doc-hook-custom-path-"));
    await simpleGit(repo).init();
    await appendFile(join(repo, ".git", "config"), "\n[core]\n\thooksPath = .githooks\n", "utf8");
    await mkdir(join(repo, ".githooks"), { recursive: true });
    await writeFile(
      join(repo, ".githooks", "post-commit"),
      "#!/usr/bin/env sh\nif [ \"$(git branch --show-current)\" != \"main\" ]; then\n  exit 0\nfi\n",
      "utf8",
    );

    await installGitHook(repo, "C:\\project\\build\\src\\index.js");

    const hook = await readFile(join(repo, ".githooks", "post-commit"), "utf8");
    expect(hook.indexOf("BEGIN Auto-Doc MCP")).toBeLessThan(hook.indexOf("exit 0"));
    expect(hook).toContain('SERVER_PATH="C:/project/build/src/index.js"');
  });
});
