import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { installGitHook } from "../git-hook/install.js";
import { startHttpBridge } from "../http-bridge/server.js";
import { storeToken } from "../installer/token-store.js";
import { writeToAllDetectedTools } from "../installer/universal-config-writer.js";

export async function runSetupWizard(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.error("\nAuto-Doc MCP - Universal Setup\n");

    const token = (await rl.question("Paste your Notion Token (secret_... or ntn_...): ")).trim();
    const isSupportedNotionToken = token.startsWith("secret_") || token.startsWith("ntn_");
    if (!isSupportedNotionToken) {
      throw new Error("Token must start with 'secret_' or 'ntn_'.");
    }

    const storage = await storeToken(token);
    process.env.NOTION_TOKEN = token;
    console.error(`\nStored token securely via ${storage}.`);

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const serverPath = path.resolve(currentDir, "..", "index.js");
    const projectPath = process.cwd();

    console.error("\nDetecting and configuring available tools...\n");
    const results = await writeToAllDetectedTools(serverPath, projectPath);

    for (const result of results) {
      if (result.status === "configured") {
        console.error(`  [configured] ${result.tool}`);
      } else if (result.status === "not-installed") {
        console.error(`  [not-installed] ${result.tool}`);
      } else {
        console.error(`  [error] ${result.tool}: ${result.error ?? "unknown error"}`);
      }
    }

    const hookAnswer = (await rl.question("\nInstall git post-commit hook fallback? (Y/n): ")).trim().toLowerCase();
    if (hookAnswer !== "n") {
      await installGitHook(projectPath, serverPath);
      console.error("Git hook installed.");
    }

    const bridgeAnswer = (await rl.question("\nStart HTTP bridge for web tools now? (y/N): ")).trim().toLowerCase();
    if (bridgeAnswer === "y") {
      await startHttpBridge();
      return;
    }

    console.error("\nSetup complete. Restart your editor to load updated MCP configs.\n");
  } finally {
    rl.close();
  }
}
