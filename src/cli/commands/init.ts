import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { installGitHook } from "../../git-hook/install.js";
import { writeGithubActionsWorkflow } from "./init-github-actions.js";

type ProjectType = "Node.js" | "Python" | "Go" | "Rust" | "Ruby" | "Generic";

interface InitOptions {
  cwd?: string;
  githubActions?: boolean;
  yes?: boolean;
}

interface InitializeToolResult {
  projectId?: string;
  projectPageId?: string;
  projectUrl?: string;
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function detectProjectType(cwd: string): Promise<ProjectType> {
  if (await exists(path.join(cwd, "package.json"))) return "Node.js";
  if ((await exists(path.join(cwd, "requirements.txt"))) || (await exists(path.join(cwd, "pyproject.toml")))) return "Python";
  if (await exists(path.join(cwd, "go.mod"))) return "Go";
  if (await exists(path.join(cwd, "Cargo.toml"))) return "Rust";
  if (await exists(path.join(cwd, "Gemfile"))) return "Ruby";
  return "Generic";
}

async function appendGitignore(cwd: string, entry: string): Promise<void> {
  const gitignorePath = path.join(cwd, ".gitignore");
  const existing = await fs.readFile(gitignorePath, "utf8").catch(() => "");
  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(entry)) {
    await fs.writeFile(gitignorePath, `${existing.trimEnd()}\n${entry}\n`, "utf8");
  }
}

function currentServerPath(): string {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(cliDir, "..", "index.js");
}

function parseProjectIdFromToolResponse(payload: unknown): InitializeToolResult {
  const text = JSON.stringify(payload);
  const projectId = /"projectId"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? /projectId[:\s]+([a-f0-9-]{32,36})/i.exec(text)?.[1];
  const projectPageId = /"projectPageId"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const projectUrl = /"projectUrl"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  return { projectId, projectPageId, projectUrl };
}

async function callInitializeTool(input: {
  serverUrl: string;
  bridgeApiKey?: string;
  projectName: string;
  parentPageId: string;
}): Promise<InitializeToolResult> {
  const headers: Record<string, string> = {};
  if (input.bridgeApiKey) {
    headers["X-Auto-Doc-Bridge-Key"] = input.bridgeApiKey;
  }

  const sseResponse = await fetch(`${input.serverUrl.replace(/\/$/, "")}/sse`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  const sseText = await sseResponse.text();
  const sessionId = /sessionId=([a-zA-Z0-9-]+)/.exec(sseText)?.[1];
  if (!sessionId) {
    throw new Error("Could not establish an MCP SSE session.");
  }

  const response = await fetch(`${input.serverUrl.replace(/\/$/, "")}/messages?sessionId=${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "initialize_project_manual",
        arguments: {
          projectName: input.projectName,
          parentPageId: input.parentPageId,
          publishingMode: "balanced",
          autoPublishThreshold: 85,
        },
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const payload = (await response.json()) as unknown;
  const parsed = parseProjectIdFromToolResponse(payload);
  if (!parsed.projectId) {
    throw new Error(`initialize_project_manual did not return a projectId: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return parsed;
}

async function writeCursorRules(cwd: string, projectId: string): Promise<void> {
  const rulesPath = path.join(cwd, ".cursorrules");
  const existing = await fs.readFile(rulesPath, "utf8").catch(() => "");
  if (existing.includes("Auto-Documentation")) {
    return;
  }

  const block = `
# Auto-Documentation
After completing any feature, call these auto-doc-mcp tools:
1. get_git_diff_summary with mode "last_commit"
2. capture_development_event with projectId "${projectId}"
3. analyze_documentation_candidate
4. If shouldDocument is true, call upsert_feature_documentation
Documentation runs as part of finishing development work.
`;
  await fs.writeFile(rulesPath, `${existing.trimEnd()}\n${block}`, "utf8");
}

async function writeProjectConfig(input: {
  cwd: string;
  projectName: string;
  projectType: ProjectType;
  projectId: string;
  serverUrl: string;
  githubActionsInstalled: boolean;
}): Promise<void> {
  const configPath = path.join(input.cwd, ".auto-doc-mcp.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        projectName: input.projectName,
        projectType: input.projectType,
        projectId: input.projectId,
        serverUrl: input.serverUrl,
        githubActionsInstalled: input.githubActionsInstalled,
        initializedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  await appendGitignore(input.cwd, ".auto-doc-mcp.json");
}

async function appendProjectEnvValue(cwd: string, key: string, value: string): Promise<void> {
  const envPath = path.join(cwd, ".env");
  const existing = await fs.readFile(envPath, "utf8").catch(() => "");
  const lines = existing.split(/\r?\n/).filter((line) => !line.startsWith(`${key}=`));
  lines.push(`${key}=${value}`);
  await fs.writeFile(envPath, `${lines.filter(Boolean).join("\n")}\n`, "utf8");
  await appendGitignore(cwd, ".env");
}

async function collectLicenseKey(input: {
  cwd: string;
  rl: readline.Interface;
  assumeYes: boolean;
}): Promise<boolean> {
  console.error("\nLicense");
  console.error("Core documentation tools are free.");
  console.error("Advanced tools such as AI-backed analysis, probing, humanizer, webhooks, packaging, and PDF export require a maintenance license.");
  console.error("You bring your own Notion token and AI provider key.\n");

  if (input.assumeYes) {
    console.error("License key skipped in --yes mode. Add AUTO_DOC_LICENSE_KEY to .env later for advanced tools.");
    return false;
  }

  const licenseKey = (await input.rl.question("License key (press Enter to skip): ")).trim();
  if (!licenseKey) {
    console.error("Skipped - core tools will work without a license.");
    return false;
  }

  if (licenseKey.split(".").length !== 3) {
    console.error("License key format looks wrong. Add it later as AUTO_DOC_LICENSE_KEY in .env.");
    return false;
  }

  await appendProjectEnvValue(input.cwd, "AUTO_DOC_LICENSE_KEY", licenseKey);
  console.error("License key saved to .env.");
  return true;
}

export async function runInit(argv: string[] = [], options: InitOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const githubActions = options.githubActions ?? (argv.includes("--github-actions") || argv.includes("--add-github-actions"));
  const assumeYes = options.yes ?? (argv.includes("--yes") || argv.includes("-y"));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const projectName = path.basename(cwd);
    const projectType = await detectProjectType(cwd);
    console.error(`\nAuto-Doc MCP init\nProject: ${projectName} (${projectType})\nDirectory: ${cwd}\n`);

    const serverUrl =
      process.env.AUTO_DOC_MCP_URL?.trim() ||
      (assumeYes ? "http://localhost:3000" : (await rl.question("MCP bridge URL (Enter for http://localhost:3000): ")).trim() || "http://localhost:3000");
    const bridgeApiKey = process.env.AUTO_DOC_BRIDGE_API_KEY?.trim();
    const parentPageId = process.env.AUTO_DOC_PARENT_PAGE_ID?.trim() || (await rl.question("Notion parent page ID: ")).trim();
    if (parentPageId.length < 32) {
      throw new Error("Notion parent page ID should be at least 32 characters.");
    }

    console.error("Creating Notion project manual...");
    const initialized = await callInitializeTool({ serverUrl, bridgeApiKey, projectName, parentPageId });
    const projectId = initialized.projectId;
    if (!projectId) {
      throw new Error("Project ID was missing after initialization.");
    }

    const serverPath = currentServerPath();
    await installGitHook(cwd, serverPath);
    await writeCursorRules(cwd, projectId);

    const shouldWriteGithubActions =
      githubActions ||
      (!assumeYes && (await rl.question("Install GitHub Actions workflow? (y/N): ")).trim().toLowerCase() === "y");
    let workflowPath: string | null = null;
    if (shouldWriteGithubActions) {
      workflowPath = await writeGithubActionsWorkflow({ cwd, serverUrl, projectId });
    }
    const licenseConfigured = await collectLicenseKey({ cwd, rl, assumeYes });

    await writeProjectConfig({
      cwd,
      projectName,
      projectType,
      projectId,
      serverUrl,
      githubActionsInstalled: Boolean(workflowPath),
    });

    console.error("\nAuto-Doc MCP initialized.");
    console.error(`Project ID: ${projectId}`);
    console.error(`Server: ${serverUrl}`);
    console.error(`Git hook: installed`);
    if (workflowPath) {
      console.error(`GitHub Actions workflow: ${workflowPath}`);
      console.error("Add AUTO_DOC_MCP_URL and AUTO_DOC_BRIDGE_API_KEY as GitHub repository secrets before relying on CI capture.");
    }
    console.error(`License: ${licenseConfigured ? "configured" : "core tools only"}`);
    console.error(`Host: ${os.hostname()}`);
  } finally {
    rl.close();
  }
}
