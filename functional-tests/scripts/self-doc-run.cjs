#!/usr/bin/env node
"use strict";

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { McpStdioClient } = require("../lib/mcp-stdio-client.cjs");

const ROOT = resolve(__dirname, "..", "..");
const RUN_ID = `self-doc-${Date.now()}`;
const ARTIFACT_ROOT = join(ROOT, "functional-tests", "artifacts", RUN_ID);
const STATE_FILE = join(ROOT, "functional-tests", `${RUN_ID}.state.json`);
const LOG_FILE = join(ROOT, "functional-tests", `${RUN_ID}.run-log.json`);
const PROVIDER_TYPE = process.env.SELF_DOC_AI_PROVIDER_TYPE || process.env.AI_PROVIDER_TYPE || "cloud-openai";
const PROVIDER_ENDPOINT = process.env.SELF_DOC_AI_ENDPOINT || process.env.AI_ENDPOINT || "https://openrouter.ai/api/v1";
const PROVIDER_MODEL = process.env.SELF_DOC_AI_MODEL_NAME || process.env.AI_MODEL_NAME || "qwen/qwen3.6-flash";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseTool(result) {
  const text = result.content?.[0]?.text;
  if (!text) throw new Error("Tool returned no text content");
  return JSON.parse(text);
}

async function readSnippet(path, limit = 1200) {
  const full = join(ROOT, path);
  if (!existsSync(full)) return "";
  return (await readFile(full, "utf8")).slice(0, limit);
}

async function notionFetch(path, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${requireEnv("NOTION_TOKEN")}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Notion ${options.method ?? "GET"} ${path} failed ${response.status}: ${body}`);
  }
  return body ? JSON.parse(body) : {};
}

const evidence = [
  {
    label: "core-mcp-tool-pipeline",
    summary:
      "Core MCP tool pipeline workflow for initializing a Notion manual, capturing development evidence, analyzing manual-worthiness, upserting feature documentation, publishing or queueing review, and packaging release manuals.",
    filesChanged: [
      "src/server.ts",
      "src/tools/initialize-project-manual.ts",
      "src/tools/capture-development-event.ts",
      "src/tools/analyze-documentation-candidate.ts",
      "src/tools/upsert-feature-documentation.ts",
      "src/tools/publish-or-queue-review.ts",
      "src/tools/package-manual.ts",
    ],
    diffSummary: "README and server registration describe the initialize -> capture -> analyze -> upsert -> publish -> package workflow exposed as MCP tools.",
  },
  {
    label: "autonomous-orchestrator",
    summary:
      "Autonomous documentation trigger workflow captures local git evidence, analyzes documentation candidates, creates user/admin manual entries, and publishes or queues the result.",
    filesChanged: ["src/tools/run-autonomous-documentation-trigger.ts", "src/orchestrator/auto-doc-orchestrator.ts", "src/evidence/git.ts"],
    diffSummary: "The orchestrator composes the registered capture, analyze, upsert, and publish tools over real git evidence.",
  },
  {
    label: "continuous-runner",
    summary:
      "Continuous documentation runner deployment mode polls configured repository targets, applies failure policy and timeout settings, and triggers autonomous documentation in the background.",
    filesChanged: ["src/runner/index.ts", "src/runner/continuous-documentation-runner.ts"],
    diffSummary: "Runner configuration uses AUTO_DOC_RUNNER_* settings, max concurrency, failure triage, release automation, and per-target timeouts.",
  },
  {
    label: "http-sse-bridge-auth",
    summary:
      "HTTP/SSE bridge integration exposes MCP over web transport with authentication, webhook ingestion, runner trigger endpoint, and closed-by-default token policy.",
    filesChanged: ["src/http-bridge/server.ts", "src/cli/bridge.ts", "tests/integration/http-bridge-auth.integration.test.ts"],
    diffSummary: "Bridge requests require explicit request tokens unless trusted local fallback is enabled; GitHub webhooks use signature validation.",
  },
  {
    label: "provider-backed-analysis",
    summary:
      "Provider-backed analysis configuration supports Bifrost, OpenAI, Anthropic, Ollama, local LM Studio, deterministic fallback, guardrails, and environment/API configuration.",
    filesChanged: ["src/lib/analyzer.ts", "src/providers/factory.ts", "src/providers/openai.ts", "src/providers/anthropic.ts", "src/providers/deterministic.ts"],
    diffSummary: "Analyzer builds structured evidence, routes to provider factory with fallback, validates output with guardrails, and redacts generated narratives.",
  },
  {
    label: "release-documentation-pipeline",
    summary:
      "Release documentation pipeline workflow packages approved/published manual entries into a release page and supports release automation from tags.",
    filesChanged: ["src/tools/run-release-documentation-pipeline.ts", "src/tools/generate-release-changelog.ts", "src/tools/package-manual.ts"],
    diffSummary: "Release tools query Notion manual entries and releases, update release relations, and produce packaged release output.",
  },
  {
    label: "export-surfaces",
    summary:
      "Export surfaces workflow produces markdown, PDF, help-center JSON, and local docs sync artifacts under an artifact-root safety boundary.",
    filesChanged: [
      "src/tools/export-manual-markdown.ts",
      "src/tools/export-manual-pdf.ts",
      "src/tools/export-help-center-content.ts",
      "src/tools/sync-manual-to-local-docs.ts",
      "src/lib/artifact-paths.ts",
    ],
    diffSummary: "Artifact writers resolve output paths through the shared artifact-root helper and export published manual entries from Notion.",
  },
  {
    label: "pr-comment-publishing",
    summary:
      "PR comment publishing integration generates a documentation preview for pull requests and publishes comments through configured repository API endpoints.",
    filesChanged: ["src/tools/generate-pr-comment-preview.ts", "src/tools/publish-pr-comment.ts"],
    diffSummary: "PR tools build documentation status comments and publish them with configured credentials while redacting secrets in logs/errors.",
  },
  {
    label: "encrypted-state-store",
    summary:
      "Encrypted local state store configuration tracks project/database ids, features, evidence snapshots, visual evidence, runner metadata, and serialized mutations.",
    filesChanged: ["src/lib/state-store.ts", "src/config.ts", "tests/integration/state-store-concurrency.integration.test.ts"],
    diffSummary: "State is encrypted with STATE_ENCRYPTION_KEY, checksummed, backed up, migrated by schema version, and mutated through a per-file queue.",
  },
  {
    label: "visual-documentation",
    summary:
      "Visual documentation feature workflow attaches path-safe figures, annotates real SVG artifacts, renders Notion image blocks, exports figures, and guards against fabricated screenshots.",
    filesChanged: [
      "src/lib/visual-evidence.ts",
      "src/tools/attach-visual-evidence.ts",
      "src/lib/screenshots.ts",
      "src/notion/manual-entry.ts",
      "tests/unit/no-fabricated-screenshots.test.ts",
    ],
    diffSummary: "Visual evidence reuses artifact-root path safety, screenshot capture is allowlisted and SSRF-guarded, and diagram fallbacks are visibly labeled as illustrations.",
  },
  {
    label: "vscode-companion",
    summary:
      "VS Code companion extension user workflow connects editor activity to the Auto-Documentation MCP server and supports developer-facing setup documentation.",
    filesChanged: ["vscode-extension/package.json", "vscode-extension/src/extension.ts"],
    diffSummary: "Repository includes a VS Code extension surface for companion integration when present in the checkout.",
  },
  {
    label: "self-hosting-docker",
    summary:
      "Self-hosting and Docker deployment configuration supports containerized bridge/runner operation, environment secrets, health checks, and operational setup.",
    filesChanged: ["Dockerfile", "docker-compose.yml", "README.md", "src/http-bridge/server.ts"],
    diffSummary: "Deployment docs and bridge code expose health/info endpoints and require production-safe secret configuration.",
  },
];

async function main() {
  const parentPageId = requireEnv("NOTION_PARENT_PAGE_ID");
  requireEnv("NOTION_TOKEN");
  const stateEncryptionKey = requireEnv("STATE_ENCRYPTION_KEY");
  await mkdir(ARTIFACT_ROOT, { recursive: true });
  const serverStderr = [];

  const client = new McpStdioClient({
    command: "node",
    args: ["build/src/index.js"],
    cwd: ROOT,
    requestTimeoutMs: Number.parseInt(process.env.SELF_DOC_REQUEST_TIMEOUT_MS || "240000", 10),
    onStderr: (chunk) => {
      serverStderr.push(chunk);
    },
    env: {
      NOTION_TOKEN: process.env.NOTION_TOKEN,
      STATE_ENCRYPTION_KEY: stateEncryptionKey,
      AUTO_DOC_STATE_FILE: STATE_FILE,
      AUTO_DOC_ARTIFACT_ROOT: ARTIFACT_ROOT,
      AI_PROVIDER_TYPE: PROVIDER_TYPE,
      AI_ENDPOINT: PROVIDER_ENDPOINT,
      AI_MODEL_NAME: PROVIDER_MODEL,
      AI_CLOUD_FALLBACK_MODEL: process.env.AI_CLOUD_FALLBACK_MODEL || PROVIDER_MODEL,
      AI_TIMEOUT_MS: process.env.AI_TIMEOUT_MS || "180000",
      AI_FALLBACK_TO_DETERMINISTIC: "false",
      AUTO_DOC_DEDICATED_AUTHORING_ENABLED: process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED || "true",
      AUTO_DOC_LOG_LEVEL: "warn",
    },
  });

  const log = {
    runId: RUN_ID,
    startedAt: new Date().toISOString(),
    artifactRoot: ARTIFACT_ROOT,
    stateFile: STATE_FILE,
    toolCalls: [],
    project: null,
    features: [],
    manualEntries: [],
    release: null,
    exports: {},
    verification: {},
    deviations: [],
    errors: [],
    provider: {
      type: PROVIDER_TYPE,
      endpoint: PROVIDER_ENDPOINT,
      modelName: PROVIDER_MODEL,
      fallbackToDeterministic: false,
    },
    serverStderr,
  };

  const call = async (name, args) => {
    const startedAt = new Date().toISOString();
    try {
      const parsed = parseTool(await client.callTool(name, args));
      log.toolCalls.push({ name, startedAt, ok: true, result: parsed });
      if (parsed?.ok === false) {
        throw new Error(`${name} returned ${parsed.error?.code ?? "error"}: ${parsed.error?.message ?? "unknown error"}`);
      }
      return parsed;
    } catch (error) {
      const entry = { name, startedAt, ok: false, error: error.message, rpc: error.rpc };
      log.toolCalls.push(entry);
      log.errors.push(entry);
      throw error;
    }
  };

  try {
    await client.start();
    await call("configure_ai_provider", {
      providerType: PROVIDER_TYPE,
      endpoint: PROVIDER_ENDPOINT,
      modelName: PROVIDER_MODEL,
      persistToEnv: false,
      runHealthCheck: true,
    });

    const initialized = await call("initialize_project_manual", {
      projectName: `Auto-Documentation MCP Server ${RUN_ID}`,
      parentPageId,
      repositoryUrl: "https://github.com/bido75/Auto-Documentation-MCP-Server",
      publishingMode: "balanced",
      autoPublishThreshold: 60,
    });
    log.project = initialized;

    for (const item of evidence) {
      const result = await call("run_autonomous_documentation_trigger", {
        projectId: initialized.projectId,
        repoPath: ROOT,
        mode: "working_tree",
        source: "local_git",
        eventType: "diff",
        summary: item.summary,
        diffSummary: item.diffSummary,
        filesChanged: item.filesChanged,
        testStatus: "passed",
      });
      log.features.push({ label: item.label, ...result });
      if (result.upsert?.manualEntryIds) {
        for (const manualEntryId of result.upsert.manualEntryIds) {
          log.manualEntries.push({ label: item.label, manualEntryId, featureId: result.upsert.featureId });
        }
      }
      if (result.disposition !== "documented") {
        log.deviations.push({ label: item.label, disposition: result.disposition });
      }
    }

    const assembled = await call("assemble_manual", {
      projectId: initialized.projectId,
    });
    log.assembledManuals = assembled;

    const packaged = await call("package_manual", {
      projectId: initialized.projectId,
      releaseVersion: RUN_ID,
      audience: "both",
      format: "markdown",
    });
    log.release = packaged;

    const markdownExport = await call("export_manual_markdown", {
      projectId: initialized.projectId,
      audience: "both",
    });
    log.exports.markdownInline = markdownExport;

    const pdfExport = await call("export_manual_pdf", {
      projectId: initialized.projectId,
      releaseVersion: RUN_ID,
      audience: "both",
      outputPath: `self-doc/${RUN_ID}/manual.pdf`,
    });
    log.exports.pdf = pdfExport;

    const helpExport = await call("export_help_center_content", {
      projectId: initialized.projectId,
      releaseVersion: RUN_ID,
      outputPath: `self-doc/${RUN_ID}/help-center.json`,
    });
    log.exports.helpCenter = helpExport;

    const localDocs = await call("sync_manual_to_local_docs", {
      projectId: initialized.projectId,
      releaseVersion: RUN_ID,
      outputPath: `self-doc/${RUN_ID}/MANUAL.md`,
    });
    log.exports.localDocs = localDocs;

    const status = await call("get_documentation_status", { projectId: initialized.projectId });
    log.verification.status = status;

    const manualPages = [];
    for (const entry of log.manualEntries) {
      const page = await notionFetch(`/pages/${entry.manualEntryId}`);
      const blocks = await notionFetch(`/blocks/${entry.manualEntryId}/children?page_size=100`);
      manualPages.push({ id: entry.manualEntryId, label: entry.label, page, blocks: blocks.results });
    }
    log.verification.manualPages = manualPages.map((page) => ({
      id: page.id,
      label: page.label,
      url: page.page.url,
      blockTypes: page.blocks.map((block) => block.type),
      text: page.blocks
        .map((block) => block.paragraph?.rich_text?.map((part) => part.plain_text).join("") ?? block.heading_2?.rich_text?.map((part) => part.plain_text).join("") ?? "")
        .filter(Boolean)
        .join("\n")
        .slice(0, 1200),
    }));

    log.completedAt = new Date().toISOString();
    await writeFile(LOG_FILE, JSON.stringify(log, null, 2), "utf8");
    console.log(JSON.stringify({ ok: true, runId: RUN_ID, logFile: LOG_FILE, project: initialized, release: packaged, exports: log.exports }, null, 2));
  } catch (error) {
    log.completedAt = new Date().toISOString();
    log.errors.push({ message: error.message, stack: error.stack });
    await writeFile(LOG_FILE, JSON.stringify(log, null, 2), "utf8");
    console.error(JSON.stringify({ ok: false, runId: RUN_ID, logFile: LOG_FILE, error: error.message }, null, 2));
    process.exitCode = 1;
  } finally {
    await client.stop().catch(() => undefined);
  }
}

main();
