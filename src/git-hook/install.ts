import * as fs from "node:fs/promises";
import * as path from "node:path";
import { simpleGit } from "simple-git";

export async function installGitHook(repoPath: string, serverPath: string): Promise<string> {
    const configuredHooksPath = await simpleGit(repoPath).raw(["config", "--get", "core.hooksPath"]).catch(() => "");
    const hooksDirectory = configuredHooksPath.trim()
        ? path.resolve(repoPath, configuredHooksPath.trim())
        : path.join(repoPath, ".git", "hooks");
    const hookPath = path.join(hooksDirectory, "post-commit");
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    const beginMarker = "# BEGIN Auto-Doc MCP - post-commit hook";
    const endMarker = "# END Auto-Doc MCP - post-commit hook";
    const legacyMarker = "# Auto-Doc MCP - post-commit hook";
    const normalizedServerPath = serverPath.replace(/\\/g, "/");
    const relativeServerPath = path.relative(repoPath, serverPath).replace(/\\/g, "/");
    const hookServerPath = relativeServerPath && !relativeServerPath.startsWith("../") && !path.isAbsolute(relativeServerPath)
        ? `$REPO_PATH/${relativeServerPath}`
        : normalizedServerPath;
    const hookBlock = `${beginMarker}
REPO_PATH="$(git rev-parse --show-toplevel)"
SERVER_PATH="${hookServerPath}"
COMMIT_SHA="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
FILES="$(git diff-tree --no-commit-id -r --name-only HEAD | head -50 | tr '\\n' ',')"
LOG_PATH="$REPO_PATH/.git/auto-doc-post-commit.log"

AUTO_DOC_HOOK_REPO_PATH="$REPO_PATH" \\
AUTO_DOC_HOOK_COMMIT_SHA="$COMMIT_SHA" \\
AUTO_DOC_HOOK_BRANCH="$BRANCH" \\
node "$SERVER_PATH" post-commit >>"$LOG_PATH" 2>&1 &

# Hook metadata for tooling visibility
echo "[auto-doc-mcp] commit=$COMMIT_SHA branch=$BRANCH files=$FILES" >/dev/null
${endMarker}`;
    const standaloneHook = `#!/usr/bin/env sh
${hookBlock}
exit 0
`;
    let existing = "";
    try {
        existing = await fs.readFile(hookPath, "utf8");
    }
    catch {
        existing = "";
    }
    let output = standaloneHook;
    if (existing.includes(beginMarker) && existing.includes(endMarker)) {
        const blockPattern = new RegExp(`${escapeRegExp(beginMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`);
        output = existing.replace(blockPattern, hookBlock);
    }
    else if (existing.includes(legacyMarker)) {
        output = standaloneHook;
    }
    else if (existing.trim().length > 0) {
        const shebangMatch = existing.match(/^#![^\r\n]*(?:\r?\n)?/u);
        if (shebangMatch) {
            output = `${shebangMatch[0]}${hookBlock}\n\n${existing.slice(shebangMatch[0].length)}`;
        }
        else {
            output = `#!/usr/bin/env sh\n${hookBlock}\n\n${existing}`;
        }
    }
    await fs.writeFile(hookPath, output, { encoding: "utf8", mode: 0o755 });
    return hookPath;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
