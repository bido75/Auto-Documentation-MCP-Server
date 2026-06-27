import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function installGitHook(repoPath: string, serverPath: string): Promise<void> {
    const hookPath = path.join(repoPath, ".git", "hooks", "post-commit");
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    const marker = "Auto-Doc MCP - post-commit hook";
    const normalizedServerPath = serverPath.replace(/\\/g, "/");
    const hookScript = `#!/usr/bin/env sh
# ${marker}
REPO_PATH="$(git rev-parse --show-toplevel)"
SERVER_PATH="${normalizedServerPath}"
COMMIT_SHA="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
FILES="$(git diff-tree --no-commit-id -r --name-only HEAD | head -50 | tr '\\n' ',')"

AUTO_DOC_HOOK_REPO_PATH="$REPO_PATH" \\
AUTO_DOC_HOOK_COMMIT_SHA="$COMMIT_SHA" \\
AUTO_DOC_HOOK_BRANCH="$BRANCH" \\
node "$SERVER_PATH" post-commit >/dev/null 2>&1 &

# Hook metadata for tooling visibility
echo "[auto-doc-mcp] commit=$COMMIT_SHA branch=$BRANCH files=$FILES" >/dev/null
exit 0
`;
    let existing = "";
    try {
        existing = await fs.readFile(hookPath, "utf8");
    }
    catch {
        existing = "";
    }
    let output = hookScript;
    if (existing.trim().length > 0 && !existing.includes(marker)) {
        output = `${existing.trimEnd()}\n\n${hookScript}`;
    }
    else if (existing.includes(marker)) {
        output = hookScript;
    }
    await fs.writeFile(hookPath, output, { encoding: "utf8", mode: 0o755 });
}
