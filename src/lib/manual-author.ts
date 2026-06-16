import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { getOptionalRuntimeConfig } from "../config.js";
import { authorManualWithFallback } from "../providers/factory.js";
import { redactSecrets } from "./redaction.js";
import { logToolEvent, resolveTraceId } from "./logger.js";
import type { Audience, EntryType } from "../types.js";

export interface ManualAuthorInput {
  audience: Audience;
  entryType: EntryType;
  featureName: string;
  summary: string;
  diffSummary?: string;
  filesChanged: string[];
  repoPath?: string;
  providerNarrative?: {
    userGuide?: {
      summary: string;
      steps: string[];
      expectedOutcome: string;
      possibleErrors: string[];
    };
    adminGuide?: {
      configRequired: string[];
      endpointsAffected: string[];
      envVarsRequired: string[];
      verificationSteps: string[];
      troubleshooting: string[];
    };
    developerNotes?: string;
    providerUsed?: string;
  };
}

export interface AuthoredManualSection {
  title: string;
  audience: Audience;
  entryType: EntryType;
  body: string;
  sourceFilesRead: string[];
  authoringTier: "tier1-dedicated" | "tier2-analyzer-narrative" | "tier3-template";
  providerUsed?: string;
}

const DEFAULT_SOURCE_CANDIDATES = ["README.md", "package.json", ".env.example", "Dockerfile", "docker-compose.yml"];
let activeAuthoringCalls = 0;
const authoringWaiters: Array<() => void> = [];

async function withAuthoringSlot<T>(fn: () => Promise<T>): Promise<T> {
  const maxConcurrent = getOptionalRuntimeConfig().authoring.maxConcurrent;
  while (activeAuthoringCalls >= maxConcurrent) {
    await new Promise<void>((resolveWaiter) => {
      authoringWaiters.push(resolveWaiter);
    });
  }

  activeAuthoringCalls += 1;
  try {
    return await fn();
  } finally {
    activeAuthoringCalls -= 1;
    const next = authoringWaiters.shift();
    if (next) {
      next();
    }
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function safeRelativeSourcePath(repoRoot: string, candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || isAbsolute(trimmed) || trimmed.split(/[\\/]+/).includes("..")) {
    return null;
  }
  const resolved = resolve(repoRoot, trimmed);
  const rel = relative(repoRoot, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return rel.replaceAll("\\", "/");
}

async function readRepoSources(repoPath: string | undefined, filesChanged: string[]): Promise<{ text: string; files: string[] }> {
  if (!repoPath) {
    return { text: "", files: [] };
  }

  const root = resolve(repoPath);
  const candidates = unique([...DEFAULT_SOURCE_CANDIDATES, ...filesChanged]).slice(0, 30);
  const chunks: string[] = [];
  const files: string[] = [];

  for (const candidate of candidates) {
    const rel = safeRelativeSourcePath(root, candidate);
    if (!rel) {
      continue;
    }
    const fullPath = resolve(root, rel);
    const content = await readFile(fullPath, "utf8").catch(() => null);
    if (!content) {
      continue;
    }
    files.push(rel);
    chunks.push(`SOURCE FILE: ${rel}\n${redactSecrets(content).slice(0, 4000)}`);
  }

  return { text: chunks.join("\n\n"), files };
}

function extractJsonScripts(sourceText: string): string[] {
  const scripts = new Set<string>();
  const scriptBlock = sourceText.match(/"scripts"\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (!scriptBlock) {
    return [];
  }
  for (const match of scriptBlock[1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) {
    scripts.add(`npm run ${match[1]} (${match[2]})`);
  }
  return [...scripts].slice(0, 8);
}

function extractPackageScripts(sourceText: string): Map<string, string> {
  const scripts = new Map<string, string>();
  const scriptBlock = sourceText.match(/"scripts"\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (!scriptBlock) {
    return scripts;
  }
  for (const match of scriptBlock[1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)) {
    scripts.set(match[1], match[2]);
  }
  return scripts;
}

function extractEnvVars(sourceText: string): string[] {
  const vars = new Set<string>();
  for (const line of sourceText.split(/\r?\n/)) {
    const trimmed = line.trim();
    const envAssignment = /^([A-Z][A-Z0-9_]{2,})\s*=/.exec(trimmed);
    if (envAssignment?.[1]) {
      vars.add(envAssignment[1]);
      continue;
    }

    const composeAssignment = /^([A-Z][A-Z0-9_]{2,})\s*:/.exec(trimmed);
    if (composeAssignment?.[1]) {
      vars.add(composeAssignment[1]);
    }
  }
  return unique([...vars])
    .filter((name) => !["SOURCE", "FILE", "README", "JSON", "CMD"].includes(name))
    .slice(0, 16);
}

function findCommand(sourceText: string, fallback: string): string {
  const scripts = extractPackageScripts(sourceText);
  const startScript = scripts.get("start");
  if (startScript) {
    return startScript;
  }
  const devScript = scripts.get("dev");
  if (devScript) {
    return devScript;
  }
  if (sourceText.includes("node build/src/cli/index.js bridge")) {
    return "node build/src/cli/index.js bridge";
  }
  const command = sourceText.match(/`([^`]*(?:node|npm|pnpm|yarn|docker)[^`]*)`/)?.[1];
  if (command && !/^\s*(?:bash|sh|powershell)?\s*\r?\nnpm\s+(?:ci|install)\s*$/i.test(command) && !/^npm\s+(?:ci|install)$/i.test(command.trim())) {
    return command.replace(/\s+/g, " ").trim();
  }
  return fallback;
}

function inferSubjectName(sourceText: string): string {
  return sourceText.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Auto-Documentation MCP Server";
}

function healthCheck(sourceText: string): string {
  const health = sourceText.match(/GET\s+\/health|\/health/)?.[0];
  return health ? "GET /health" : "check the command output for a successful startup message";
}

function bulletList(items: string[], fallback: string[]): string {
  const list = items.length > 0 ? items : fallback;
  return list.map((item) => `- ${item}`).join("\n");
}

function numberedSteps(steps: string[]): string {
  return steps.map((step, index) => `${index + 1}. ${step}`).join("\n");
}

function stripEvidenceDumpMarkers(input: string): string {
  return input
    .replace(/Repo evidence excerpt:\s*/gi, "")
    .replace(/Files changed:\s*/gi, "Relevant implementation areas: ")
    .replace(/\b(GET|POST|PUT|PATCH|DELETE|MCP|HTTP|RPC)\b(?:\s+\b(GET|POST|PUT|PATCH|DELETE|MCP|HTTP|RPC)\b)+/g, "")
    .trim();
}

function cleanManualBody(input: string): string {
  return redactSecrets(stripEvidenceDumpMarkers(input));
}

function providerNarrativeIsUsable(input: ManualAuthorInput): boolean {
  const providerUsed = input.providerNarrative?.providerUsed?.trim().toLowerCase();
  return Boolean(providerUsed && providerUsed !== "deterministic");
}

function logAuthoringTierFallback(input: { from: string; to: string; reason: string; error?: unknown }): void {
  const message = input.error instanceof Error ? input.error.message : input.error === undefined ? undefined : String(input.error);
  logToolEvent({
    level: "warn",
    tool: "manual_author",
    stage: "authoring_tier_fallback",
    traceId: resolveTraceId(),
    message: `Manual authoring fallback ${input.from} -> ${input.to}: ${input.reason}`,
    data: {
      from: input.from,
      to: input.to,
      reason: input.reason,
      ...(message === undefined ? {} : { error: message }),
    },
  });
}

function nextFallbackTier(input: ManualAuthorInput): "tier2-analyzer-narrative" | "tier3-template" {
  return providerNarrativeIsUsable(input) ? "tier2-analyzer-narrative" : "tier3-template";
}

function authoringAudience(input: ManualAuthorInput): "User" | "Admin" | "Internal" {
  if (input.audience === "Admin" || input.entryType === "Admin Guide") {
    return "Admin";
  }
  if (input.audience === "Internal" || input.entryType === "Developer Note") {
    return "Internal";
  }
  return "User";
}

function envDescription(name: string): string {
  const descriptions: Record<string, string> = {
    NOTION_TOKEN: "Notion integration token used to read and write project manual pages.",
    STATE_ENCRYPTION_KEY: "High-entropy key used to encrypt the local state store.",
    AUTO_DOC_HTTP_PORT: "Port used by the HTTP/SSE bridge.",
    AUTO_DOC_HTTP_HOST: "Host interface used by the HTTP/SSE bridge.",
    AUTO_DOC_RUNNER_PROJECT_ID: "Project id that the continuous runner processes.",
    AUTO_DOC_RUNNER_REPO_PATH: "Repository path watched by the continuous runner.",
    AUTO_DOC_RUNNER_TARGETS: "JSON array of runner targets for multi-project automation.",
    GITHUB_WEBHOOK_SECRET: "Shared secret used to verify GitHub webhook signatures.",
    AI_SESSION_WEBHOOK_SECRET: "Shared secret used to verify AI-session webhook signatures.",
    AI_PROVIDER_TYPE: "Provider selector for analysis-time model calls.",
    AI_ENDPOINT: "Base URL for the configured model provider.",
    AI_MODEL_NAME: "Model name sent to the configured provider.",
    OPENROUTER_API_KEY: "Cloud fallback key for OpenRouter-compatible model calls.",
    BIFROST_VIRTUAL_KEY: "Bifrost governance virtual key sent with Bifrost requests.",
  };
  return descriptions[name] ?? "Runtime setting required by this deployment path.";
}

function envReference(items: string[]): string {
  return bulletList(items.map((name) => `${name}: ${envDescription(name)}`), []);
}

function renderProviderUserBody(input: ManualAuthorInput): string {
  const userGuide = input.providerNarrative?.userGuide;
  if (!userGuide) {
    return "";
  }
  return [
    "## Overview",
    userGuide.summary,
    "",
    "## Step-by-step setup",
    numberedSteps(userGuide.steps.length > 0 ? userGuide.steps : ["Open the documented workflow.", "Complete the action described by the feature."]),
    "",
    `Expected result: ${userGuide.expectedOutcome}`,
    "",
    "## Troubleshooting",
    bulletList(userGuide.possibleErrors, ["If the workflow is unavailable, check access permissions and retry."]),
  ].join("\n");
}

function renderProviderAdminBody(input: ManualAuthorInput): string {
  const adminGuide = input.providerNarrative?.adminGuide;
  if (!adminGuide) {
    return "";
  }
  const envVars = unique(adminGuide.envVarsRequired);
  return [
    "## Overview",
    `${input.featureName} operational guidance from ${input.providerNarrative?.providerUsed}.`,
    "",
    "## Requirements",
    bulletList(adminGuide.configRequired.length > 0 ? adminGuide.configRequired : ["No additional configuration required."], []),
    "",
    "## Operations setup",
    numberedSteps(adminGuide.verificationSteps.length > 0 ? adminGuide.verificationSteps : ["Deploy the change.", "Verify the affected workflow." ]),
    "",
    ...(adminGuide.endpointsAffected.length > 0 ? ["## Affected endpoints", bulletList(adminGuide.endpointsAffected, []), ""] : []),
    ...(envVars.length > 0 ? ["## Configuration reference", envReference(envVars), ""] : []),
    "## Troubleshooting",
    bulletList(adminGuide.troubleshooting, ["Check deployment logs and verify required settings are present."]),
  ].join("\n");
}

function renderProviderDeveloperBody(input: ManualAuthorInput): string {
  return [
    "## Implementation notes",
    input.providerNarrative?.developerNotes?.trim() || input.diffSummary || input.summary,
  ].join("\n");
}

function buildUserBody(input: ManualAuthorInput, sourceText: string): string {
  if (providerNarrativeIsUsable(input)) {
    return renderProviderUserBody(input);
  }
  const providerSteps = input.providerNarrative?.userGuide?.steps ?? [];
  const startCommand = findCommand(sourceText, "node build/src/index.js");
  const subjectName = inferSubjectName(sourceText);
  const userVisibleEnv = extractEnvVars(sourceText).filter((name) => ["NOTION_TOKEN", "AUTO_DOC_HTTP_PORT"].includes(name));
  const steps = providerSteps.length > 0
    ? providerSteps
    : [
        "Run `npm install` to install dependencies.",
        "Run `npm run build` to compile the server.",
        `Start the MCP server with \`${startCommand}\`.`,
        "Open your MCP client and call the documentation tools for your project.",
        "Export the finished manual when the entries are published.",
      ];

  return [
    "## Overview",
    `${subjectName} helps a user turn development work into readable Notion documentation without hand-maintaining a manual. ${redactSecrets(stripEvidenceDumpMarkers(input.summary))}`,
    "",
    "## Prerequisites",
    bulletList(["Node.js installed", "Notion integration token", "Access to the repository you want to document"], []),
    "",
    "## Step-by-step setup",
    numberedSteps(steps),
    "",
    `Expected result: the MCP server starts, the project manual can be initialized, and documentation entries can be captured and exported.`,
    "",
    "## How to use it",
    numberedSteps([
      "Use the MCP server from your coding assistant or MCP client.",
      "Initialize a project manual under a Notion parent page.",
      "Capture a development event after a meaningful feature change.",
      "Run analysis and publish or queue the generated documentation.",
      "Export the manual to markdown, help-center JSON, local docs, or PDF when ready.",
    ]),
    ...(userVisibleEnv.length > 0 ? ["", "## Useful settings", bulletList(userVisibleEnv, [])] : []),
    "",
    "## Troubleshooting",
    bulletList(input.providerNarrative?.userGuide?.possibleErrors ?? [], [
      "If the server cannot connect to Notion, check the token and parent page access.",
      "If no entry is generated, confirm the evidence describes a user or admin-facing workflow.",
    ]),
  ].join("\n");
}

function buildAdminBody(input: ManualAuthorInput, sourceText: string): string {
  if (providerNarrativeIsUsable(input)) {
    return renderProviderAdminBody(input);
  }
  const envVars = unique([
    ...(input.providerNarrative?.adminGuide?.envVarsRequired ?? []),
    ...extractEnvVars(sourceText),
    "NOTION_TOKEN",
    "STATE_ENCRYPTION_KEY",
    "AUTO_DOC_RUNNER_PROJECT_ID",
    "AUTO_DOC_RUNNER_REPO_PATH",
  ]);
  const scripts = extractJsonScripts(sourceText);
  const startCommand = sourceText.includes("node build/src/cli/index.js bridge")
    ? "node build/src/cli/index.js bridge"
    : findCommand(sourceText, "node build/src/cli/index.js bridge");
  const check = healthCheck(sourceText);
  const verificationSteps = input.providerNarrative?.adminGuide?.verificationSteps ?? [];

  return [
    "## Overview",
    `${input.featureName} is the operational path for deploying, securing, and monitoring Auto-Documentation in a real environment. ${redactSecrets(stripEvidenceDumpMarkers(input.summary))}`,
    "",
    "## Requirements",
    bulletList(["Node.js runtime", "Writable Notion integration", "Unique STATE_ENCRYPTION_KEY", "Network access from the bridge or runner host"], []),
    "",
    "## Operations setup",
    numberedSteps([
      "Set `NOTION_TOKEN` for the Notion integration and keep it out of committed files.",
      "Set `STATE_ENCRYPTION_KEY` to a unique high-entropy value before bridge or runner mode.",
      `Start bridge mode with \`${startCommand}\` when web/SSE access is required.`,
      "Configure runner mode with `AUTO_DOC_RUNNER_PROJECT_ID` and `AUTO_DOC_RUNNER_REPO_PATH` for background documentation.",
      `Verify the service with \`${check}\`.`,
    ]),
    "",
    "Expected result: the bridge or runner starts with production-safe secrets, health checks pass, and documentation jobs can run without exposing tokens.",
    "",
    "## Configuration reference",
    envReference(envVars.length > 0 ? envVars : ["NOTION_TOKEN", "STATE_ENCRYPTION_KEY", "AUTO_DOC_RUNNER_PROJECT_ID", "AUTO_DOC_RUNNER_REPO_PATH"]),
    "",
    "## Useful commands",
    bulletList(scripts, ["npm run build", "node build/src/index.js", "node build/src/cli/index.js bridge"]),
    "",
    "## Troubleshooting",
    bulletList([...(input.providerNarrative?.adminGuide?.troubleshooting ?? []), ...verificationSteps], [
      "If startup fails in production, confirm STATE_ENCRYPTION_KEY is not the default development value.",
      "If /health fails, inspect bridge logs and confirm the configured port is reachable.",
      "If runner jobs stop, review failure triage metadata and target repository access.",
    ]),
  ].join("\n");
}

function buildDeveloperBody(input: ManualAuthorInput, sourceText: string): string {
  if (providerNarrativeIsUsable(input)) {
    return renderProviderDeveloperBody(input);
  }
  const scripts = extractJsonScripts(sourceText);
  return [
    "## Overview",
    `${input.featureName} is an internal implementation area. ${redactSecrets(stripEvidenceDumpMarkers(input.providerNarrative?.developerNotes ?? input.diffSummary ?? input.summary))}`,
    "",
    "## Prerequisites",
    bulletList(["Repository checkout", "Node.js dependencies installed", "A test state file or disposable Notion workspace"], []),
    "",
    "## Step-by-step setup",
    numberedSteps(["Install dependencies with `npm install`.", "Run the relevant build or test command.", "Inspect generated Notion or artifact output for the expected behavior."]),
    "",
    "Expected result: the implementation can be built, tested, and verified without relying on hand-edited documentation.",
    "",
    "## Reference",
    bulletList(scripts, ["npm run build", "npm test"]),
  ].join("\n");
}

export async function authorManualSection(input: ManualAuthorInput): Promise<AuthoredManualSection> {
  const sources = await readRepoSources(input.repoPath, input.filesChanged);
  const sourceText = `${sources.text}\n\n${redactSecrets(input.diffSummary ?? "")}`;
  const runtime = getOptionalRuntimeConfig();

  if (runtime.authoring.dedicatedEnabled) {
    try {
      const result = await withAuthoringSlot(() =>
        authorManualWithFallback({
          audience: authoringAudience(input),
          entryType: input.entryType,
          featureName: input.featureName,
          summary: input.summary,
          diffSummary: input.diffSummary,
          filesChanged: input.filesChanged,
          sourceText,
        }),
      );
      return {
        title: input.featureName,
        audience: input.audience,
        entryType: input.entryType,
        body: cleanManualBody(result.body),
        sourceFilesRead: sources.files,
        authoringTier: "tier1-dedicated",
        providerUsed: result.providerUsed,
      };
    } catch (error) {
      logAuthoringTierFallback({
        from: "tier1-dedicated",
        to: nextFallbackTier(input),
        reason: "Dedicated authoring provider did not produce a usable manual section.",
        error,
      });
    }
  } else if (providerNarrativeIsUsable(input)) {
    logAuthoringTierFallback({
      from: "tier1-dedicated",
      to: "tier2-analyzer-narrative",
      reason: "Dedicated authoring is disabled by configuration.",
    });
  }

  if (providerNarrativeIsUsable(input)) {
    const tier2Body =
      input.audience === "Admin" || input.entryType === "Admin Guide"
        ? renderProviderAdminBody(input)
        : input.audience === "User" || input.entryType === "User Guide"
          ? renderProviderUserBody(input)
          : renderProviderDeveloperBody(input);

    return {
      title: input.featureName,
      audience: input.audience,
      entryType: input.entryType,
      body: cleanManualBody(tier2Body),
      sourceFilesRead: sources.files,
      authoringTier: "tier2-analyzer-narrative",
      providerUsed: input.providerNarrative?.providerUsed,
    };
  }

  const body =
    input.audience === "Admin" || input.entryType === "Admin Guide"
      ? buildAdminBody(input, sourceText)
      : input.audience === "User" || input.entryType === "User Guide"
        ? buildUserBody(input, sourceText)
        : buildDeveloperBody(input, sourceText);

  return {
    title: input.featureName,
    audience: input.audience,
    entryType: input.entryType,
    body: cleanManualBody(body),
    sourceFilesRead: sources.files,
    authoringTier: "tier3-template",
  };
}
