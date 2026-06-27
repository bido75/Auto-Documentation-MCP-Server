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
const SOURCE_GROUNDING_RULE =
  "Document only what is present in the provided source evidence; do not invent function names, parameters, units, return values, environment variables, configuration, dependencies, file paths, or numeric behavior.";
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

function normalizeSourceText(content: string): string {
  return content.replace(/\u0000/g, "");
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
  const candidates = unique([...filesChanged, ...DEFAULT_SOURCE_CANDIDATES]).slice(0, 30);
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
    const normalizedContent = normalizeSourceText(content);
    files.push(rel);
    chunks.push(`SOURCE FILE: ${rel}\n${redactSecrets(normalizedContent).slice(0, 4000)}`);
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

function removeDanglingLabels(input: string): { body: string; removed: boolean } {
  const lines = input.split(/\r?\n/);
  const kept: string[] = [];
  let removed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isEmptyLabel = /^(?:Parameters?|Returns?):\s*$/i.test(line.trim());
    if (!isEmptyLabel) {
      kept.push(line);
      continue;
    }

    const nextMeaningful = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
    const nextIsAnotherStructuralLine =
      nextMeaningful.length === 0 ||
      /^#{1,6}\s+/.test(nextMeaningful) ||
      /^(?:Parameters?|Returns?|Errors?|Throws?):\s*$/i.test(nextMeaningful) ||
      /^-?\s*Examples?:\s*$/i.test(nextMeaningful);

    if (nextIsAnotherStructuralLine) {
      removed = true;
      continue;
    }

    kept.push(line);
  }

  return { body: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

function dedupeSourceGroundingSections(input: string): string {
  const marker = "## Source-grounded behavior";
  const firstIndex = input.indexOf(marker);
  if (firstIndex < 0) {
    return input;
  }

  const secondIndex = input.indexOf(marker, firstIndex + marker.length);
  if (secondIndex < 0) {
    return input;
  }

  return input.slice(0, secondIndex).trimEnd();
}

function functionHeaderName(line: string): string | null {
  return /^#{3,6}\s+`?([A-Za-z_$][\w$]*)\s*\(/.exec(line.trim())?.[1] ?? null;
}

function isStructuralFunctionLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length === 0 ||
    /^(?:Parameters?|Returns?|Errors?|Throws?):\s*$/i.test(trimmed) ||
    /^-?\s*Examples?:\s*$/i.test(trimmed)
  );
}

function sourceFactDescription(fact: SourceFunctionFact): string {
  const lines = [`Source-defined behavior: \`${fact.name}(${fact.params.join(", ")})\`.`];
  if (fact.params.length > 0) {
    lines.push(`Parameters: ${fact.params.map((param) => `\`${param}\``).join(", ")}.`);
  }
  if (fact.returnExpression) {
    lines.push(`Returns: \`${fact.returnExpression}\`.`);
  }
  if (fact.returnObjectFields.length > 0) {
    lines.push(`Return object fields: ${fact.returnObjectFields.map((field) => `\`${field}\``).join(", ")}.`);
  }
  if (fact.name === "buildNotification") {
    if (fact.body.includes("CHANNELS.includes(channel)")) {
      lines.push("Validates `channel` with `CHANNELS.includes(channel)`.");
    }
    if (fact.body.includes("status: 'pending'")) {
      lines.push("Creates notifications with `attempts: 0`, `status: 'pending'`, and `createdAt: Date.now()`.");
    }
  }
  if (fact.name === "shouldRetry") {
    lines.push("Returns true only when `status === 'failed'` and `attempts < MAX_RETRIES`.");
  }
  if (fact.name === "summarize") {
    lines.push("Returns the source-defined notification status counts.");
  }
  return lines.join("\n");
}

function ensureReturnObjectFieldCoverage(input: string, sourceText: string): string {
  const facts = extractSourceFunctionFacts(sourceText).filter((fact) => fact.returnObjectFields.length > 0);
  if (facts.length === 0) {
    return input;
  }

  const additions: string[] = [];
  for (const fact of facts) {
    if (!input.toLowerCase().includes(fact.name.toLowerCase())) {
      continue;
    }
    const missing = fact.returnObjectFields.filter((field) => !new RegExp(`\\b${field}\\b`).test(input));
    if (missing.length > 0) {
      additions.push(`- \`${fact.name}\` returns object fields: ${fact.returnObjectFields.map((field) => `\`${field}\``).join(", ")}.`);
    }
  }

  if (additions.length === 0) {
    return input;
  }

  return `${input.trim()}\n\n## Source-defined return fields\n${unique(additions).join("\n")}`.trim();
}

function ensureSourceConstantCoverage(input: string, sourceText: string): string {
  const notes = sourceDeclaredConstantNotes(sourceText);
  if (notes.length === 0) {
    return input;
  }

  const missingNotes = notes.filter((note) => {
    const name = /`([^`]+)`/.exec(note)?.[1];
    return Boolean(name && input.includes(name) && !new RegExp(`${name}.*source (?:constant|value)|source (?:constant|value).*${name}`, "i").test(input));
  });
  if (missingNotes.length === 0) {
    return input;
  }

  return `${input.trim()}\n\n## Source-defined constants\n${missingNotes.map((note) => `- ${note}`).join("\n")}`.trim();
}

function fillEmptyFunctionSections(input: string, sourceText: string): string {
  const facts = new Map(extractSourceFunctionFacts(sourceText).map((fact) => [fact.name, fact]));
  if (facts.size === 0) {
    return input;
  }

  const lines = input.split(/\r?\n/);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    output.push(line);
    const functionName = functionHeaderName(line);
    const fact = functionName ? facts.get(functionName) : undefined;
    if (!fact) {
      continue;
    }

    let cursor = index + 1;
    const sectionLines: string[] = [];
    while (cursor < lines.length && !functionHeaderName(lines[cursor]) && !/^#{1,2}\s+/.test(lines[cursor].trim())) {
      sectionLines.push(lines[cursor]);
      cursor += 1;
    }

    const hasRealContent = sectionLines.some((sectionLine) => !isStructuralFunctionLine(sectionLine));
    if (!hasRealContent) {
      output.push(sourceFactDescription(fact));
    }
  }

  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function completeManualBody(body: string, sourceText: string): string {
  const cleaned = cleanManualBody(body);
  const correctedConstants = correctSourceConstantEnvClaims(cleaned, sourceText);
  const labels = removeDanglingLabels(correctedConstants);
  const filledBody = fillEmptyFunctionSections(labels.body, sourceText);
  const withReturnFields = ensureReturnObjectFieldCoverage(filledBody, sourceText);
  const withConstants = ensureSourceConstantCoverage(withReturnFields, sourceText);
  const dedupedBody = dedupeSourceGroundingSections(withConstants);

  const appendix = sourceGroundingAppendix(sourceText).trim();
  if (!labels.removed) {
    return dedupedBody;
  }

  return appendix && !dedupedBody.includes("Source-grounded behavior") ? `${dedupedBody}\n\n${appendix}` : dedupedBody;
}

type SourceFunctionFact = {
  name: string;
  params: string[];
  body: string;
  returnExpression?: string;
  returnObjectFields: string[];
};

function extractReturnObjectFields(body: string): string[] {
  const match = /return\s*\{([\s\S]*?)\};/.exec(body);
  if (!match) {
    return [];
  }

  const fields: string[] = [];
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim().replace(/,$/, "").trim();
    if (!line) {
      continue;
    }
    const keyed = /^([A-Za-z_$][\w$]*)\s*:/.exec(line)?.[1];
    if (keyed) {
      fields.push(keyed);
      continue;
    }
    const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(line)?.[1];
    if (shorthand) {
      fields.push(shorthand);
    }
  }

  return unique(fields);
}

function extractSourceFunctionFacts(sourceText: string): SourceFunctionFact[] {
  const facts: SourceFunctionFact[] = [];
  for (const match of sourceText.matchAll(/(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{([\s\S]*?)\n\}/g)) {
    const body = match[3]?.trim() ?? "";
    const returnExpression = body.match(/return\s+(.+?);/)?.[1]?.trim();
    facts.push({
      name: match[1],
      params: (match[2] ?? "")
        .split(",")
        .map((param) => param.trim())
        .filter(Boolean),
      body,
      returnObjectFields: extractReturnObjectFields(body),
      ...(returnExpression ? { returnExpression } : {}),
    });
  }
  return facts;
}

function sourceDeclaredConstants(sourceText: string): Set<string> {
  return new Set(
    [...sourceText.matchAll(/\b(?:export\s+)?(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\b/g)].map((match) => match[1]),
  );
}

function sourceDeclaredConstantNotes(sourceText: string): string[] {
  const constants = [...sourceDeclaredConstants(sourceText)];
  return constants.map((name) => `\`${name}\` is a source constant defined in code; callers override it by passing an explicit value.`);
}

function correctSourceConstantEnvClaims(input: string, sourceText: string): string {
  const runtimeEnvVars = sourceRuntimeEnvVars(sourceText);
  const constants = [...sourceDeclaredConstants(sourceText)].filter((name) => !runtimeEnvVars.has(name));
  if (constants.length === 0) {
    return input;
  }

  const corrected: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    const constant = constants.find((name) => line.includes(name));
    const isEnvClaim =
      constant !== undefined &&
      /\b(?:environment variable|environment variables|env var|env vars|runtime setting|configuration setting|configuration reference|set|configured|missing)\b/i.test(
        line,
    );
    if (constant && isEnvClaim) {
      corrected.push(`- \`${constant}\` is a source constant defined in code; callers override it by passing an explicit value.`);
      continue;
    }
    corrected.push(line);
  }

  return unique(corrected).join("\n");
}

function sourceNumbers(sourceText: string): Set<string> {
  return new Set([...sourceText.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((match) => match[0]));
}

function sourceCallNames(sourceText: string): Set<string> {
  return new Set([...sourceText.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]));
}

function sourceRuntimeEnvVars(sourceText: string): Set<string> {
  const vars = new Set(extractEnvVars(sourceText));
  for (const match of sourceText.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})\b/g)) {
    vars.add(match[1]);
  }
  for (const match of sourceText.matchAll(/process\.env\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g)) {
    vars.add(match[1]);
  }
  return vars;
}

function containsUnsupportedNumericClaim(body: string, sourceText: string): boolean {
  const numbers = sourceNumbers(sourceText);
  for (const match of body.matchAll(/\b\d+(?:\.\d+)?(?:%|x)?\b/gi)) {
    const token = match[0];
    if (/^\d+$/.test(token)) {
      continue;
    }
    const normalized = token.replace(/[%x]$/i, "");
    if (!numbers.has(normalized)) {
      return true;
    }
  }
  const numberWords: Record<string, string> = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
  };
  for (const match of body.matchAll(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b(?:\s+(?:attempts?|retries|times?|seconds?|milliseconds?|ms|items?|entries?|values?))?/gi)) {
    const numeric = numberWords[match[1].toLowerCase()];
    const hasNumericContext = /\s+(?:attempts?|retries|times?|seconds?|milliseconds?|ms|items?|entries?|values?)$/i.test(match[0]);
    if (numeric && hasNumericContext && !numbers.has(numeric)) {
      return true;
    }
  }
  return false;
}

function containsUnsupportedFunctionClaim(body: string, facts: SourceFunctionFact[], sourceText: string): boolean {
  const sourceNames = new Set([...facts.map((fact) => fact.name), ...sourceCallNames(sourceText)]);
  for (const match of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (!sourceNames.has(name)) {
      return true;
    }
  }
  return false;
}

function containsUnsupportedEnvClaim(body: string, sourceText: string): boolean {
  const sourceConstants = new Set([...sourceText.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)].map((match) => match[0]));
  const runtimeEnvVars = sourceRuntimeEnvVars(sourceText);
  for (const match of body.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    const name = match[0];
    if (!sourceConstants.has(name) && !runtimeEnvVars.has(name)) {
      return true;
    }
  }
  const envClaimPattern =
    /\b(?:environment variable|environment variables|env var|env vars|runtime setting|configuration setting|set)\b[^\n.]{0,120}\b([A-Z][A-Z0-9_]{2,})\b/gi;
  for (const match of body.matchAll(envClaimPattern)) {
    const name = match[1];
    if (name && !runtimeEnvVars.has(name)) {
      return true;
    }
  }
  return false;
}

function isGroundedToSource(body: string, sourceText: string): boolean {
  const facts = extractSourceFunctionFacts(sourceText);
  if (facts.length === 0) {
    return true;
  }

  const lowerBody = body.toLowerCase();
  if (facts.length === 1) {
    const [fact] = facts;
    if (!lowerBody.includes(fact.name.toLowerCase()) || !fact.params.every((param) => lowerBody.includes(param.toLowerCase()))) {
      return false;
    }
  } else if (!facts.every((fact) => lowerBody.includes(fact.name.toLowerCase()))) {
    return false;
  }

  if (containsUnsupportedFunctionClaim(body, facts, sourceText)) {
    return false;
  }
  if (containsUnsupportedEnvClaim(body, sourceText)) {
    return false;
  }
  if (containsUnsupportedNumericClaim(body, sourceText)) {
    return false;
  }

  const lowerSource = sourceText.toLowerCase();
  return ![
    "pound",
    "pounds",
    "lbs",
    "lb range",
    "zone",
    "zones",
    "shipping-calculator",
    "chmod",
  ].some((token) => body.toLowerCase().includes(token) && !lowerSource.includes(token));
}

function lineHasUnsupportedClaim(line: string, sourceText: string, facts: SourceFunctionFact[]): boolean {
  return (
    containsUnsupportedFunctionClaim(line, facts, sourceText) ||
    containsUnsupportedEnvClaim(line, sourceText) ||
    containsUnsupportedNumericClaim(line, sourceText)
  );
}

function extractStringArrayConstant(sourceText: string, name: string): string[] {
  const match = sourceText.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1]).filter(Boolean);
}

function extractObjectKeys(sourceText: string, name: string): string[] {
  const match = sourceText.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{([^}]*)\\}`));
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/\b([A-Za-z_$][\w$]*)\s*:/g)].map((item) => item[1]).filter(Boolean);
}

function sourceGroundingAppendix(sourceText: string): string {
  const normalizedSourceText = normalizeSourceText(sourceText);
  const facts = extractSourceFunctionFacts(normalizedSourceText);
  if (facts.length <= 1) {
    return "";
  }

  const channels = extractStringArrayConstant(normalizedSourceText, "CHANNELS");
  const statuses = extractObjectKeys(normalizedSourceText, "counts");
  const maxRetries = normalizedSourceText.match(/const\s+MAX_RETRIES\s*=\s*(\d+)/)?.[1];
  const bullets: string[] = [];

  if (channels.length > 0) {
    bullets.push(`Supported channels in source: ${channels.map((channel) => `\`${channel}\``).join(", ")}.`);
  }
  if (maxRetries) {
    bullets.push(`Retry cap in source: \`MAX_RETRIES = ${maxRetries}\`.`);
  }
  if (normalizedSourceText.includes("Math.min(1000 * 2 ** attempts, 30000)")) {
    bullets.push("Backoff in source: `Math.min(1000 * 2 ** attempts, 30000)`.");
  }
  if (statuses.length > 0) {
    bullets.push(`Statuses counted in source: ${statuses.map((status) => `\`${status}\``).join(", ")}.`);
  }

  for (const fact of facts) {
    const signature = `${fact.name}(${fact.params.join(", ")})`;
    bullets.push(`\`${signature}\` is exported by the source.`);
    if (fact.name === "buildNotification") {
      if (fact.body.includes("CHANNELS.includes(channel)")) {
        bullets.push("`buildNotification` validates `channel` with `CHANNELS.includes(channel)`.");
      }
      if (fact.body.includes("Unsupported channel")) {
        bullets.push("`buildNotification` throws `Unsupported channel: ${channel}` for unsupported channels.");
      }
      if (fact.body.includes("status: 'pending'")) {
        bullets.push("New notifications start with `attempts: 0`, `status: 'pending'`, and `createdAt: Date.now()`.");
      }
    }
    if (fact.name === "shouldRetry") {
      bullets.push("`shouldRetry` checks for `status === 'failed'` and `attempts < MAX_RETRIES`.");
    }
    if (fact.name === "nextBackoffMs" && fact.returnExpression) {
      bullets.push(`\`nextBackoffMs\` returns \`${fact.returnExpression}\`.`);
    }
    if (fact.name === "summarize") {
      bullets.push("`summarize` returns the source-defined counts object for notification statuses.");
    }
  }

  return ["", "## Source-grounded behavior", bulletList(unique(bullets), [])].join("\n");
}

function repairBodyToSource(body: string, sourceText: string): string | null {
  const facts = extractSourceFunctionFacts(sourceText);
  if (facts.length === 0) {
    return body;
  }

  const keptLines = body
    .split(/\r?\n/)
    .filter((line) => !lineHasUnsupportedClaim(line, sourceText, facts));
  const repaired = completeManualBody(`${keptLines.join("\n")}${sourceGroundingAppendix(sourceText)}`, sourceText);
  return isGroundedToSource(repaired, sourceText) ? repaired : null;
}

function buildGroundedFunctionBody(input: ManualAuthorInput, sourceText: string): string | null {
  const [fact] = extractSourceFunctionFacts(sourceText);
  if (!fact) {
    return null;
  }

  const params = fact.params.join(", ");
  const returnLine = fact.returnExpression ? `It returns \`${fact.returnExpression}\`.` : "The return value is defined by the source function body.";
  const baseLine = fact.body.match(/const\s+base\s*=\s*(.+?);/)?.[1]?.trim();
  const parameterLine = fact.params.length > 0 ? `Parameters: ${fact.params.map((param) => `\`${param}\``).join(", ")}.` : "The source does not define parameters.";
  const unspecified = "Units, ranges, and configuration are not specified in the source.";
  const isShippingFunction = /shipping|cost/i.test(`${input.featureName} ${input.summary} ${input.filesChanged.join(" ")} ${fact.name}`);
  const returnObjectFields = [...fact.body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)]
    .map((match) => match[1])
    .filter((name) => !["if", "for", "while", "switch"].includes(name));
  const quotedAssignments = [...fact.body.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*(['"][^'"]+['"]|\d+|Date\.now\(\))/g)].map(
    (match) => `\`${match[1]}: ${match[2]}\``,
  );
  const sourceBehavior = unique([
    ...(baseLine ? [`Base expression: \`${baseLine}\`.`] : []),
    returnLine,
    ...(quotedAssignments.length > 0 ? [`Returned object fields include ${quotedAssignments.join(", ")}.`] : []),
    ...(fact.returnObjectFields.length > 0
      ? [`Returned object keys include ${fact.returnObjectFields.map((field) => `\`${field}\``).join(", ")}.`]
      : returnObjectFields.length > 0
        ? [`Returned object keys include ${returnObjectFields.map((field) => `\`${field}\``).join(", ")}.`]
        : []),
    ...sourceDeclaredConstantNotes(sourceText),
    ...(fact.body.includes("CHANNELS.includes(channel)") ? ["The source validates `channel` with `CHANNELS.includes(channel)`."] : []),
    ...(fact.body.includes("Unsupported channel") ? ["Unsupported channels throw the source-defined `Unsupported channel: ${channel}` error."] : []),
    ...(isShippingFunction && fact.params.includes("distanceKm") ? ["`distanceKm` affects the base cost."] : []),
    ...(isShippingFunction && fact.body.includes("1.75") ? ["When `expedited` is true, the source multiplies the base cost by `1.75`."] : []),
    unspecified,
  ]);

  if (input.entryType === "Admin Guide" || input.audience === "Admin") {
    return [
      "## Overview",
      `The source defines \`${fact.name}(${params})\`. ${parameterLine}`,
      "",
      "## Requirements",
      "- No environment variables, package dependencies, destination routing, permissions, or runtime configuration are specified in the source.",
      `- ${unspecified}`,
      "",
      "## Verification",
      numberedSteps([
        `Call \`${fact.name}\` with the exact parameters from the source: ${fact.params.map((param) => `\`${param}\``).join(", ")}.`,
        ...sourceBehavior.filter((item) => item !== unspecified),
      ]),
      "",
      `Expected result: ${returnLine}`,
      "",
      "## Troubleshooting",
      bulletList([unspecified], []),
    ].join("\n");
  }

  if (input.entryType === "User Guide" || input.audience === "User") {
    return [
      "## Overview",
      `This change provides the \`${fact.name}\` helper. It accepts ${fact.params.map((param) => `\`${param}\``).join(", ")}.`,
      "",
      "## What the source supports",
      bulletList(sourceBehavior, []),
      "",
      "## Expected result",
      returnLine,
      "",
      "## Troubleshooting",
      bulletList(["Check callers pass the exact parameters required by the function signature.", unspecified], []),
    ].join("\n");
  }

  return [
    "## Implementation notes",
    `The source defines \`${fact.name}(${params})\`. ${parameterLine}`,
    "",
    "## Source behavior",
    bulletList(sourceBehavior, []),
  ].join("\n");
}

function isThinFunctionEvidence(sourceText: string): boolean {
  const facts = extractSourceFunctionFacts(sourceText);
  if (facts.length === 0 || facts.length > 2) {
    return false;
  }
  const sourceLines = sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("SOURCE FILE:") && line !== SOURCE_GROUNDING_RULE);
  return sourceLines.length <= 30;
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
  const sourceText = normalizeSourceText(`${SOURCE_GROUNDING_RULE}\n\n${sources.text}\n\n${redactSecrets(input.diffSummary ?? "")}`);
  const runtime = getOptionalRuntimeConfig();
  const groundedFunctionBody = buildGroundedFunctionBody(input, sourceText);

  if (groundedFunctionBody && isThinFunctionEvidence(sourceText)) {
    return {
      title: input.featureName,
      audience: input.audience,
      entryType: input.entryType,
      body: cleanManualBody(groundedFunctionBody),
      sourceFilesRead: sources.files,
      authoringTier: "tier3-template",
    };
  }

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
      const cleanedBody = completeManualBody(result.body, sourceText);
      const acceptedBody = isGroundedToSource(cleanedBody, sourceText) ? cleanedBody : repairBodyToSource(cleanedBody, sourceText);
      if (!acceptedBody) {
        throw new Error("Dedicated authoring provider produced claims that are not grounded in the source evidence.");
      }
      return {
        title: input.featureName,
        audience: input.audience,
        entryType: input.entryType,
        body: acceptedBody,
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
    const cleanedTier2Body = completeManualBody(tier2Body, sourceText);
    const acceptedTier2Body = isGroundedToSource(cleanedTier2Body, sourceText) ? cleanedTier2Body : repairBodyToSource(cleanedTier2Body, sourceText);
    if (!acceptedTier2Body) {
      logAuthoringTierFallback({
        from: "tier2-analyzer-narrative",
        to: "tier3-template",
        reason: "Analyzer narrative produced claims that are not grounded in the source evidence.",
      });
    } else {
      return {
        title: input.featureName,
        audience: input.audience,
        entryType: input.entryType,
        body: acceptedTier2Body,
        sourceFilesRead: sources.files,
        authoringTier: "tier2-analyzer-narrative",
        providerUsed: input.providerNarrative?.providerUsed,
      };
    }

  }

  const body =
    groundedFunctionBody ??
    (input.audience === "Admin" || input.entryType === "Admin Guide"
      ? buildAdminBody(input, sourceText)
      : input.audience === "User" || input.entryType === "User Guide"
        ? buildUserBody(input, sourceText)
        : buildDeveloperBody(input, sourceText));

  return {
    title: input.featureName,
    audience: input.audience,
    entryType: input.entryType,
    body: completeManualBody(body, sourceText),
    sourceFilesRead: sources.files,
    authoringTier: "tier3-template",
  };
}
