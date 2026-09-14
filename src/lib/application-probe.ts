import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { assertRepoPathAllowed } from "./repo-paths.js";
import { redactSecrets } from "./redaction.js";
import type { ProjectState } from "./state-store.js";

export type ProbedFeatureKind = "api_endpoint" | "ui_component" | "env_config" | "package_script" | "exported_symbol";

export interface ProbedFeature {
  featureKey: string;
  featureName: string;
  kind: ProbedFeatureKind;
  summary: string;
  files: string[];
  evidence: Array<{
    file: string;
    line: number;
    snippet: string;
  }>;
  routes: string[];
  apiEndpoints: string[];
  envVars: string[];
  confidenceScore: number;
}

export interface ApplicationProbeInventory {
  schemaVersion: 1;
  repoPath: string;
  generatedAt: string;
  fileCount: number;
  features: ProbedFeature[];
}

export interface DocumentationGap {
  featureKey: string;
  featureName: string;
  kind: ProbedFeatureKind;
  status: "missing" | "documented";
  reason: string;
  files: string[];
  routes: string[];
  apiEndpoints: string[];
  envVars: string[];
  evidence: ProbedFeature["evidence"];
  confidenceScore: number;
}

export interface GapReport {
  schemaVersion: 1;
  projectId: string;
  generatedAt: string;
  totalDiscovered: number;
  documentedCount: number;
  missingCount: number;
  gaps: DocumentationGap[];
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs"]);
const ROOT_FILES = new Set(["package.json", ".env.example", "docker-compose.yml", "Dockerfile", "README.md"]);
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "build",
  "dist",
  "coverage",
  ".auto-doc",
  ".auto-doc-mcp",
  "artifacts",
  "bifrost-data",
]);
const MAX_FILES = 700;
const MAX_FILE_BYTES = 220_000;

function slug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function titleize(input: string): string {
  return input
    .replace(/[-_:./]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function pushFeature(features: Map<string, ProbedFeature>, feature: ProbedFeature): void {
  const existing = features.get(feature.featureKey);
  if (!existing) {
    features.set(feature.featureKey, feature);
    return;
  }

  existing.files = Array.from(new Set([...existing.files, ...feature.files]));
  existing.routes = Array.from(new Set([...existing.routes, ...feature.routes]));
  existing.apiEndpoints = Array.from(new Set([...existing.apiEndpoints, ...feature.apiEndpoints]));
  existing.envVars = Array.from(new Set([...existing.envVars, ...feature.envVars]));
  existing.evidence.push(...feature.evidence);
  existing.confidenceScore = Math.max(existing.confidenceScore, feature.confidenceScore);
}

function makeFeature(input: {
  kind: ProbedFeatureKind;
  keySeed: string;
  name: string;
  summary: string;
  file: string;
  line: number;
  snippet: string;
  routes?: string[];
  apiEndpoints?: string[];
  envVars?: string[];
  confidenceScore: number;
}): ProbedFeature {
  return {
    featureKey: `probe:${input.kind}:${slug(input.keySeed)}`,
    featureName: input.name,
    kind: input.kind,
    summary: input.summary,
    files: [input.file],
    evidence: [{ file: input.file, line: input.line, snippet: redactSecrets(input.snippet.trim()).slice(0, 500) }],
    routes: input.routes ?? [],
    apiEndpoints: input.apiEndpoints ?? [],
    envVars: input.envVars ?? [],
    confidenceScore: input.confidenceScore,
  };
}

async function walk(root: string, current: string, files: string[]): Promise<void> {
  if (files.length >= MAX_FILES) {
    return;
  }

  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (files.length >= MAX_FILES) {
      return;
    }
    if (entry.name.startsWith(".") && !ROOT_FILES.has(entry.name) && entry.name !== ".env.example") {
      if (entry.isDirectory()) {
        continue;
      }
    }
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        await walk(root, fullPath, files);
      }
      continue;
    }

    const rel = relative(root, fullPath).replaceAll("\\", "/");
    const ext = extname(entry.name);
    if (!SOURCE_EXTENSIONS.has(ext) && !ROOT_FILES.has(basename(entry.name))) {
      continue;
    }
    const size = await stat(fullPath).then((value) => value.size).catch(() => 0);
    if (size > MAX_FILE_BYTES) {
      continue;
    }
    files.push(rel);
  }
}

function scanPackageJson(features: Map<string, ProbedFeature>, file: string, content: string): void {
  let parsed: { scripts?: Record<string, string> } | null = null;
  try {
    parsed = JSON.parse(content) as { scripts?: Record<string, string> };
  } catch {
    return;
  }

  for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
    if (!/^(start|dev|build|test|lint|serve|preview|deploy|cli|migrate|seed|worker|runner)/i.test(name)) {
      continue;
    }
    const line = content.slice(0, content.indexOf(`"${name}"`)).split(/\r?\n/).length;
    pushFeature(
      features,
      makeFeature({
        kind: "package_script",
        keySeed: name,
        name: `${titleize(name)} Command`,
        summary: `Package script "${name}" runs "${command}".`,
        file,
        line,
        snippet: `"${name}": "${command}"`,
        confidenceScore: 78,
      }),
    );
  }
}

function scanSource(features: Map<string, ProbedFeature>, file: string, content: string): void {
  const lines = content.replace(/\u0000/g, "").split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const snippet = line.trim();
    if (!snippet) {
      return;
    }

    for (const match of snippet.matchAll(/\b(?:app|router|server)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gi)) {
      const method = match[1].toUpperCase();
      const route = match[2];
      pushFeature(
        features,
        makeFeature({
          kind: "api_endpoint",
          keySeed: `${method} ${route}`,
          name: `${method} ${route}`,
          summary: `API endpoint ${method} ${route} is declared in ${file}.`,
          file,
          line: lineNumber,
          snippet,
          routes: [route],
          apiEndpoints: [`${method} ${route}`],
          confidenceScore: 86,
        }),
      );
    }

    for (const match of snippet.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]{2,})\b/g)) {
      const envVar = match[1];
      pushFeature(
        features,
        makeFeature({
          kind: "env_config",
          keySeed: envVar,
          name: `${envVar} Configuration`,
          summary: `Environment variable ${envVar} is read by the application.`,
          file,
          line: lineNumber,
          snippet,
          envVars: [envVar],
          confidenceScore: 75,
        }),
      );
    }

    for (const match of snippet.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z][A-Za-z0-9_]*)\b/g)) {
      const symbol = match[1];
      if (/^(register|create|build|get|set|parse|normalize|resolve)/.test(symbol)) {
        continue;
      }
      pushFeature(
        features,
        makeFeature({
          kind: "exported_symbol",
          keySeed: `${file}:${symbol}`,
          name: titleize(symbol),
          summary: `Exported function ${symbol} is available from ${file}.`,
          file,
          line: lineNumber,
          snippet,
          confidenceScore: 64,
        }),
      );
    }

    if (/\.(tsx|jsx)$/.test(file)) {
      const componentMatch = snippet.match(/\bexport\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\b/);
      if (componentMatch) {
        const component = componentMatch[1];
        pushFeature(
          features,
          makeFeature({
            kind: "ui_component",
            keySeed: `${file}:${component}`,
            name: `${titleize(component)} UI`,
            summary: `UI component ${component} is exported from ${file}.`,
            file,
            line: lineNumber,
            snippet,
            confidenceScore: 72,
          }),
        );
      }
    }
  });
}

export async function probeApplication(input: { repoPath: string; generatedAt?: Date }): Promise<ApplicationProbeInventory> {
  const repoPath = await assertRepoPathAllowed(input.repoPath);
  const root = resolve(repoPath);
  const files: string[] = [];
  await walk(root, root, files);

  const features = new Map<string, ProbedFeature>();
  for (const file of files) {
    const content = await readFile(join(root, file), "utf8").catch(() => "");
    if (!content) {
      continue;
    }
    if (basename(file) === "package.json") {
      scanPackageJson(features, file, content);
    }
    scanSource(features, file, content);
  }

  return {
    schemaVersion: 1,
    repoPath,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    fileCount: files.length,
    features: [...features.values()].sort((a, b) => b.confidenceScore - a.confidenceScore || a.featureKey.localeCompare(b.featureKey)),
  };
}

export function generateGapReport(input: {
  project: ProjectState;
  inventory: ApplicationProbeInventory;
  generatedAt?: Date;
}): GapReport {
  const documented = new Set(Object.keys(input.project.featuresByKey));
  const gaps: DocumentationGap[] = input.inventory.features.map((feature) => {
    const isDocumented = documented.has(feature.featureKey);
    return {
      featureKey: feature.featureKey,
      featureName: feature.featureName,
      kind: feature.kind,
      status: isDocumented ? "documented" : "missing",
      reason: isDocumented ? "Feature key already exists in project state." : "No matching feature key exists in project state.",
      files: feature.files,
      routes: feature.routes,
      apiEndpoints: feature.apiEndpoints,
      envVars: feature.envVars,
      evidence: feature.evidence,
      confidenceScore: feature.confidenceScore,
    };
  });

  return {
    schemaVersion: 1,
    projectId: input.project.projectId,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    totalDiscovered: gaps.length,
    documentedCount: gaps.filter((gap) => gap.status === "documented").length,
    missingCount: gaps.filter((gap) => gap.status === "missing").length,
    gaps,
  };
}
