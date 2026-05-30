import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { installGitHook } from "../git-hook/install.js";
import { startHttpBridge } from "../http-bridge/server.js";
import { storeToken } from "../installer/token-store.js";
import { writeToAllDetectedTools } from "../installer/universal-config-writer.js";

type SetupArgs = {
  token?: string;
  installHook?: boolean;
  startBridge?: boolean;
  nonInteractive: boolean;
  projectPath?: string;
  serverPath?: string;
};

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseSetupArgs(argv: string[], env: NodeJS.ProcessEnv): SetupArgs {
  const args: SetupArgs = {
    nonInteractive: parseBooleanFlag(env.AUTO_DOC_SETUP_NON_INTERACTIVE) ?? false,
    token: env.AUTO_DOC_SETUP_TOKEN?.trim() || undefined,
    installHook: parseBooleanFlag(env.AUTO_DOC_SETUP_INSTALL_HOOK),
    startBridge: parseBooleanFlag(env.AUTO_DOC_SETUP_START_BRIDGE),
    projectPath: env.AUTO_DOC_SETUP_PROJECT_PATH?.trim() || undefined,
    serverPath: env.AUTO_DOC_SETUP_SERVER_PATH?.trim() || undefined,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = argv[index + 1];

    if (argument === "--non-interactive") {
      args.nonInteractive = true;
      continue;
    }

    if (argument === "--token" && next) {
      args.token = next.trim();
      index += 1;
      continue;
    }

    if (argument === "--install-hook" && next) {
      args.installHook = parseBooleanFlag(next);
      index += 1;
      continue;
    }

    if (argument === "--start-bridge" && next) {
      args.startBridge = parseBooleanFlag(next);
      index += 1;
      continue;
    }

    if (argument === "--project-path" && next) {
      args.projectPath = next.trim();
      index += 1;
      continue;
    }

    if (argument === "--server-path" && next) {
      args.serverPath = next.trim();
      index += 1;
      continue;
    }
  }

  return args;
}

export async function runSetupWizard(): Promise<void> {
  const options = parseSetupArgs(process.argv, process.env);
  const rl = options.nonInteractive
    ? null
    : readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

  try {
    console.log("\nAuto-Doc MCP - Universal Setup\n");
    const token = options.token ?? (await rl?.question("Paste your Notion Token (secret_... or ntn_...): "))?.trim() ?? "";
    if (options.nonInteractive && token.length === 0) {
      throw new Error("Non-interactive setup requires --token or AUTO_DOC_SETUP_TOKEN.");
    }

    const isSupportedNotionToken = token.startsWith("secret_") || token.startsWith("ntn_");
    if (!isSupportedNotionToken) {
      throw new Error("Token must start with 'secret_' or 'ntn_'.");
    }

    const storage = await storeToken(token);
    process.env.NOTION_TOKEN = token;
    console.log(`\nStored token securely via ${storage}.`);

    const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = options.serverPath ?? path.resolve(currentDir, "..", "index.js");
  const projectPath = options.projectPath ?? process.cwd();

    console.log("\nDetecting and configuring available tools...\n");
    const results = await writeToAllDetectedTools(serverPath, projectPath);
    for (const result of results) {
      if (result.status === "configured") {
        console.log(`  [configured] ${result.tool}`);
      } else if (result.status === "not-installed") {
        console.log(`  [not-installed] ${result.tool}`);
      } else {
        console.log(`  [error] ${result.tool}: ${result.error ?? "unknown error"}`);
      }
    }

    const installHook =
      options.installHook ?? (((await rl?.question("\nInstall git post-commit hook fallback? (Y/n): "))?.trim().toLowerCase() ?? "") !== "n");
    if (installHook) {
      await installGitHook(projectPath, serverPath);
      console.log("Git hook installed.");
    }

    const startBridge =
      options.startBridge ?? (((await rl?.question("\nStart HTTP bridge for web tools now? (y/N): "))?.trim().toLowerCase() ?? "") === "y");
    if (startBridge) {
      await startHttpBridge();
      return;
    }

    console.log("\nSetup complete. Restart your editor to load updated MCP configs.\n");
  } finally {
    rl?.close();
  }
}
