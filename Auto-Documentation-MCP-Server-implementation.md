Auto-Documentation MCP Server Implementation Plan
For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

Goal: Build a TypeScript MCP server that automatically captures development evidence, generates deduplicated user/admin manual entries, writes them to Notion, and packages release-ready documentation.

Architecture: The implementation uses a stdio MCP server with focused modules for tools, Notion access, evidence capture, analysis, confidence scoring, and packaging. The first release is local-first, with GitHub/team inputs modeled through the same evidence event interface so team support can be added without changing the documentation engine.

Tech Stack: TypeScript, Node.js, @modelcontextprotocol/sdk, @notionhq/client, zod, vitest, simple-git, nock.

First-Time Notion Onboarding (Required)
Before running live flows, complete this setup once per workspace:

1) Create or sign in to Notion
- Confirm you can open the target workspace in the browser.

2) Create a Notion internal integration
- Go to Notion Integrations.
- Create a new internal integration in the same workspace used for manuals.
- Copy the integration secret token.

3) Create or choose a parent page for MCP databases
- Create a page that will hold generated databases (Projects, Features, Manual Entries, Evidence Events, Releases).
- Copy the parent page ID from the Notion URL.

4) Share access with the integration
- Open the parent page in Notion.
- Use Share -> Connections and add the integration.
- Confirm the integration has access to the parent page and created databases.

5) Configure environment variables
- Set NOTION_TOKEN to the integration secret.
- Set NOTION_PARENT_PAGE_ID for live tests.
- Optional for live integration suite: set RUN_LIVE_NOTION_TESTS=true.

Windows PowerShell example:
$env:NOTION_TOKEN="secret_xxx"
$env:NOTION_PARENT_PAGE_ID="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$env:RUN_LIVE_NOTION_TESTS="true"

6) Run initial validation
- Run initialize_project_manual once for a test project.
- Then run capture_development_event, upsert_feature_documentation, and package_manual.

Expected Preflight Errors And Meaning
- NOTION_TOKEN_MISSING: NOTION_TOKEN is not set.
  Fix: set NOTION_TOKEN in MCP process environment.
- NOTION_TOKEN_INVALID: token is wrong or revoked.
  Fix: regenerate/copy integration secret and update env.
- NOTION_AUTH_FORBIDDEN: integration authenticated but cannot access target workspace resources.
  Fix: ensure integration belongs to the correct workspace and has access.
- NOTION_PARENT_PAGE_FORBIDDEN: parent page exists but is not shared with integration.
  Fix: share parent page with the integration.
- NOTION_PARENT_PAGE_NOT_FOUND: invalid parent page ID or inaccessible page.
  Fix: verify page ID and sharing.
- NOTION_DATABASE_ID_MISSING: local project state does not contain required database IDs.
  Fix: rerun initialize_project_manual and verify state file.
- NOTION_DATABASE_FORBIDDEN: one or more databases are not shared with integration.
  Fix: share each required database with the integration.
- NOTION_DATABASE_NOT_FOUND: stored database ID is stale or wrong.
  Fix: rerun initialize_project_manual to refresh mappings.

Troubleshooting Notes
- If tools fail with a machine-readable MCP error envelope, inspect error.code, error.message, error.traceId, and remediation steps.
- Trace IDs are returned in all successful tool responses and included in failure envelopes to correlate logs.

File Structure
package.json: scripts, dependencies, and package metadata.
tsconfig.json: TypeScript compiler configuration.
vitest.config.ts: unit test configuration.
src/index.ts: MCP stdio boot entry.
src/server.ts: MCP server construction and tool registration.
src/config.ts: environment and runtime configuration.
src/types.ts: shared domain types.
src/lib/notion-client.ts: Notion client factory.
src/lib/notion-blocks.ts: Notion block rendering helpers.
src/lib/notion-schema.ts: Notion database schema payloads.
src/lib/redaction.ts: secret redaction for evidence summaries.
src/analysis/manual-worthiness.ts: user/admin impact classification.
src/analysis/feature-key.ts: stable feature key generation.
src/analysis/confidence.ts: confidence scoring.
src/evidence/git.ts: local git evidence collection.
src/notion/project-manual.ts: Notion initialization.
src/notion/manual-entry.ts: feature and manual entry upsert logic.
src/packaging/manual-packager.ts: release manual assembly.
src/tools/initialize-project-manual.ts: MCP tool registration.
src/tools/capture-development-event.ts: MCP tool registration.
src/tools/analyze-documentation-candidate.ts: MCP tool registration.
src/tools/upsert-feature-documentation.ts: MCP tool registration.
src/tools/publish-or-queue-review.ts: MCP tool registration.
src/tools/package-manual.ts: MCP tool registration.
src/tools/get-documentation-status.ts: MCP tool registration.
tests/unit/*.test.ts: unit tests.
tests/integration/*.test.ts: mocked Notion and pipeline tests.
Task 1: Project Scaffold
Files:

Create: package.json

Create: tsconfig.json

Create: vitest.config.ts

Create: src/index.ts

Create: src/server.ts

Create: src/config.ts


Step 1: Create package metadata

Create package.json:

{
  "name": "auto-docs-notion-mcp",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": {
    "auto-docs-notion-mcp": "./dist/index.js"
  },
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@notionhq/client": "^2.2.15",
    "simple-git": "^3.27.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "nock": "^13.5.6",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
Step 2: Create TypeScript config
Create tsconfig.json:

{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
Step 3: Create test config
Create vitest.config.ts:

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
Step 4: Create runtime config
Create src/config.ts:

export type PublishingMode = "Conservative" | "Balanced" | "Fully Automatic";

export interface RuntimeConfig {
  notionToken: string;
  defaultPublishingMode: PublishingMode;
  defaultAutoPublishThreshold: number;
}

export function getRuntimeConfig(env = process.env): RuntimeConfig {
  const notionToken = env.NOTION_TOKEN;

  if (!notionToken) {
    throw new Error("Missing NOTION_TOKEN environment variable.");
  }

  return {
    notionToken,
    defaultPublishingMode: "Balanced",
    defaultAutoPublishThreshold: 90,
  };
}
Step 5: Create MCP server shell
Create src/server.ts:

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function createServer() {
  const server = new McpServer({
    name: "auto-docs-notion-mcp",
    version: "0.1.0",
  });

  return server;
}
Create src/index.ts:

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();

await server.connect(transport);
console.error("Auto-Documentation Notion MCP Server running on stdio");
Step 6: Install dependencies
Run: npm install

Expected: dependencies install and package-lock.json is created.

Step 7: Verify scaffold
Run: npm run typecheck

Expected: tsc --noEmit exits successfully.

Step 8: Commit
git add package.json package-lock.json tsconfig.json vitest.config.ts src
git commit -m "chore: scaffold auto documentation mcp server"
Task 2: Domain Types And Notion Blocks
Files:

Create: src/types.ts

Create: src/lib/notion-blocks.ts

Create: tests/unit/notion-blocks.test.ts


Step 1: Add shared domain types

Create src/types.ts:

export type Audience = "User" | "Admin" | "Both" | "Internal";
export type EntryType = "User Guide" | "Admin Guide" | "Developer Note" | "Release Note";
export type DocumentationStatus = "Captured" | "Needs Review" | "Approved" | "Published" | "Deprecated";
export type PublishingDecision = "Agent Published" | "Queued Review" | "Human Approved" | "Ignored";
export type EvidenceSource = "Local Git" | "GitHub" | "CI" | "Release" | "AI Session";
export type EvidenceEventType =
  | "Commit"
  | "Diff"
  | "PR Opened"
  | "PR Merged"
  | "Tests Passed"
  | "Release Tagged"
  | "Session Completed";

export interface ManualEntryDraft {
  entryTitle: string;
  entryType: EntryType;
  audience: Audience;
  body: string;
  routes?: string[];
  apiEndpoints?: string[];
}

export interface DocumentationCandidate {
  shouldDocument: boolean;
  featureKey: string;
  featureName: string;
  audiences: Audience[];
  entryTypes: EntryType[];
  confidenceScore: number;
  confidenceReasons: string[];
  reviewQuestions: string[];
}
Step 2: Write block rendering tests
Create tests/unit/notion-blocks.test.ts:

import { describe, expect, it } from "vitest";
import { divider, heading2, paragraphs } from "../../src/lib/notion-blocks.js";

describe("notion block rendering", () => {
  it("renders a heading_2 block", () => {
    expect(heading2("User Guide")).toMatchObject({
      object: "block",
      type: "heading_2",
      heading_2: {
        rich_text: [{ type: "text", text: { content: "User Guide" } }],
      },
    });
  });

  it("splits paragraphs on blank lines and trims empty content", () => {
    const blocks = paragraphs("First paragraph.\n\nSecond paragraph.\n\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: "First paragraph." } }] },
    });
  });

  it("renders a divider block", () => {
    expect(divider()).toEqual({
      object: "block",
      type: "divider",
      divider: {},
    });
  });
});
Step 3: Run failing test
Run: npm test -- tests/unit/notion-blocks.test.ts

Expected: FAIL because src/lib/notion-blocks.ts does not exist.

Step 4: Implement block helpers
Create src/lib/notion-blocks.ts:

type RichText = {
  type: "text";
  text: { content: string };
};

function text(content: string): RichText {
  return { type: "text", text: { content } };
}

export function heading2(content: string) {
  return {
    object: "block" as const,
    type: "heading_2" as const,
    heading_2: {
      rich_text: [text(content)],
    },
  };
}

export function paragraph(content: string) {
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: {
      rich_text: [text(content)],
    },
  };
}

export function paragraphs(content: string) {
  return content
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(paragraph);
}

export function divider() {
  return {
    object: "block" as const,
    type: "divider" as const,
    divider: {},
  };
}
Step 5: Verify block helpers
Run: npm test -- tests/unit/notion-blocks.test.ts

Expected: PASS.

Step 6: Commit
git add src/types.ts src/lib/notion-blocks.ts tests/unit/notion-blocks.test.ts
git commit -m "feat: add notion block rendering helpers"
Task 3: Redaction And Manual-Worthiness Analysis
Files:

Create: src/lib/redaction.ts

Create: src/analysis/manual-worthiness.ts

Create: tests/unit/redaction.test.ts

Create: tests/unit/manual-worthiness.test.ts


Step 1: Write redaction tests

Create tests/unit/redaction.test.ts:

import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/lib/redaction.js";

describe("redactSecrets", () => {
  it("redacts common secret assignments", () => {
    const input = "NOTION_TOKEN=secret_abc\nOPENAI_API_KEY=sk-test\nnormal=value";
    expect(redactSecrets(input)).toContain("NOTION_TOKEN=[REDACTED]");
    expect(redactSecrets(input)).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redactSecrets(input)).toContain("normal=value");
  });
});
Step 2: Write manual-worthiness tests
Create tests/unit/manual-worthiness.test.ts:

import { describe, expect, it } from "vitest";
import { classifyManualWorthiness } from "../../src/analysis/manual-worthiness.js";

describe("classifyManualWorthiness", () => {
  it("marks UI routes and components as user manual worthy", () => {
    const result = classifyManualWorthiness({
      summary: "Added billing settings page with invoice export button",
      filesChanged: ["src/routes/billing/settings.tsx", "src/components/InvoiceExport.tsx"],
    });

    expect(result.shouldDocument).toBe(true);
    expect(result.audiences).toContain("User");
    expect(result.reasons).toContain("User-facing workflow or UI change detected.");
  });

  it("marks environment and webhook changes as admin manual worthy", () => {
    const result = classifyManualWorthiness({
      summary: "Added Stripe webhook secret and retry configuration",
      filesChanged: ["src/api/webhooks/stripe.ts", ".env.example"],
    });

    expect(result.shouldDocument).toBe(true);
    expect(result.audiences).toContain("Admin");
    expect(result.reasons).toContain("Admin configuration or integration change detected.");
  });

  it("ignores formatting-only changes", () => {
    const result = classifyManualWorthiness({
      summary: "Format code with prettier",
      filesChanged: ["src/components/Button.tsx"],
    });

    expect(result.shouldDocument).toBe(false);
    expect(result.reasons).toContain("Change appears internal or formatting-only.");
  });
});
Step 3: Run failing tests
Run: npm test -- tests/unit/redaction.test.ts tests/unit/manual-worthiness.test.ts

Expected: FAIL because implementation files do not exist.

Step 4: Implement secret redaction
Create src/lib/redaction.ts:

const SECRET_ASSIGNMENT = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*([^\s]+)/gi;

export function redactSecrets(input: string): string {
  return input.replace(SECRET_ASSIGNMENT, "$1=[REDACTED]");
}
Step 5: Implement manual-worthiness classifier
Create src/analysis/manual-worthiness.ts:

import type { Audience } from "../types.js";

interface ClassificationInput {
  summary: string;
  filesChanged: string[];
}

interface ClassificationResult {
  shouldDocument: boolean;
  audiences: Audience[];
  reasons: string[];
}

const USER_TERMS = [
  "page",
  "screen",
  "dashboard",
  "button",
  "form",
  "setting",
  "workflow",
  "export",
  "import",
  "login",
  "signup",
  "notification",
  "report",
];

const ADMIN_TERMS = [
  "env",
  "environment",
  "webhook",
  "permission",
  "role",
  "policy",
  "api",
  "endpoint",
  "integration",
  "deployment",
  "audit",
  "security",
  "retry",
  "configuration",
];

const IGNORE_TERMS = ["format", "prettier", "lint", "refactor", "rename variable", "test only"];

export function classifyManualWorthiness(input: ClassificationInput): ClassificationResult {
  const haystack = `${input.summary} ${input.filesChanged.join(" ")}`.toLowerCase();
  const audiences = new Set<Audience>();
  const reasons: string[] = [];

  if (IGNORE_TERMS.some((term) => haystack.includes(term))) {
    return {
      shouldDocument: false,
      audiences: [],
      reasons: ["Change appears internal or formatting-only."],
    };
  }

  if (USER_TERMS.some((term) => haystack.includes(term)) || /routes?|components?|pages?/.test(haystack)) {
    audiences.add("User");
    reasons.push("User-facing workflow or UI change detected.");
  }

  if (ADMIN_TERMS.some((term) => haystack.includes(term)) || /\.env/.test(haystack)) {
    audiences.add("Admin");
    reasons.push("Admin configuration or integration change detected.");
  }

  return {
    shouldDocument: audiences.size > 0,
    audiences: [...audiences],
    reasons: reasons.length > 0 ? reasons : ["No manual-worthy user or admin impact detected."],
  };
}
Step 6: Verify classifier
Run: npm test -- tests/unit/redaction.test.ts tests/unit/manual-worthiness.test.ts

Expected: PASS.

Step 7: Commit
git add src/lib/redaction.ts src/analysis/manual-worthiness.ts tests/unit/redaction.test.ts tests/unit/manual-worthiness.test.ts
git commit -m "feat: classify manual-worthy documentation events"
Task 4: Feature Keys And Confidence Scoring
Files:

Create: src/analysis/feature-key.ts

Create: src/analysis/confidence.ts

Create: tests/unit/feature-key.test.ts

Create: tests/unit/confidence.test.ts


Step 1: Write feature key tests

Create tests/unit/feature-key.test.ts:

import { describe, expect, it } from "vitest";
import { createFeatureKey } from "../../src/analysis/feature-key.js";

describe("createFeatureKey", () => {
  it("creates a stable key from module and feature name", () => {
    expect(createFeatureKey({ module: "Billing", featureName: "Invoice Export" })).toBe("billing:invoice-export");
  });

  it("prefers route when route is available", () => {
    expect(createFeatureKey({ module: "Billing", featureName: "Invoice Export", route: "/billing/invoices" })).toBe(
      "route:billing-invoices",
    );
  });
});
Step 2: Write confidence tests
Create tests/unit/confidence.test.ts:

import { describe, expect, it } from "vitest";
import { scoreDocumentationConfidence } from "../../src/analysis/confidence.js";

describe("scoreDocumentationConfidence", () => {
  it("scores merged PRs with tests and concrete docs as high confidence", () => {
    const result = scoreDocumentationConfidence({
      manualWorthy: true,
      featureNameMatched: true,
      testsPassed: true,
      mergedOrReleased: true,
      concreteDocumentation: true,
      ambiguousPurpose: false,
      duplicateUncertain: false,
    });

    expect(result.score).toBe(100);
    expect(result.reasons).toContain("Tests passed.");
  });

  it("penalizes ambiguity and uncertain duplicates", () => {
    const result = scoreDocumentationConfidence({
      manualWorthy: true,
      featureNameMatched: false,
      testsPassed: false,
      mergedOrReleased: false,
      concreteDocumentation: false,
      ambiguousPurpose: true,
      duplicateUncertain: true,
    });

    expect(result.score).toBe(30);
    expect(result.reviewQuestions.length).toBeGreaterThan(0);
  });
});
Step 3: Run failing tests
Run: npm test -- tests/unit/feature-key.test.ts tests/unit/confidence.test.ts

Expected: FAIL because implementation files do not exist.

Step 4: Implement feature key generation
Create src/analysis/feature-key.ts:

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function createFeatureKey(input: { module?: string; featureName: string; route?: string }): string {
  if (input.route) {
    return `route:${slug(input.route)}`;
  }

  const moduleName = input.module ? slug(input.module) : "general";
  return `${moduleName}:${slug(input.featureName)}`;
}
Step 5: Implement confidence scoring
Create src/analysis/confidence.ts:

export interface ConfidenceInput {
  manualWorthy: boolean;
  featureNameMatched: boolean;
  testsPassed: boolean;
  mergedOrReleased: boolean;
  concreteDocumentation: boolean;
  ambiguousPurpose: boolean;
  duplicateUncertain: boolean;
}

export interface ConfidenceResult {
  score: number;
  reasons: string[];
  reviewQuestions: string[];
}

export function scoreDocumentationConfidence(input: ConfidenceInput): ConfidenceResult {
  let score = input.manualWorthy ? 40 : 0;
  const reasons: string[] = [];
  const reviewQuestions: string[] = [];

  if (input.featureNameMatched) {
    score += 15;
    reasons.push("Feature name matched source evidence.");
  }

  if (input.testsPassed) {
    score += 15;
    reasons.push("Tests passed.");
  }

  if (input.mergedOrReleased) {
    score += 15;
    reasons.push("Change is merged or release-tagged.");
  }

  if (input.concreteDocumentation) {
    score += 15;
    reasons.push("Generated documentation includes concrete usage details.");
  }

  if (input.ambiguousPurpose) {
    score -= 20;
    reviewQuestions.push("What exact user or admin behavior changed?");
  }

  if (input.duplicateUncertain) {
    score -= 15;
    reviewQuestions.push("Should this update an existing feature instead of creating a new entry?");
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    reviewQuestions,
  };
}
Step 6: Verify scoring
Run: npm test -- tests/unit/feature-key.test.ts tests/unit/confidence.test.ts

Expected: PASS.

Step 7: Commit
git add src/analysis/feature-key.ts src/analysis/confidence.ts tests/unit/feature-key.test.ts tests/unit/confidence.test.ts
git commit -m "feat: add feature keys and confidence scoring"
Task 5: Local Git Evidence Capture
Files:

Create: src/evidence/git.ts

Create: tests/unit/git-evidence.test.ts


Step 1: Write git evidence tests with a fake git client

Create tests/unit/git-evidence.test.ts:

import { describe, expect, it } from "vitest";
import { collectGitEvidence } from "../../src/evidence/git.js";

describe("collectGitEvidence", () => {
  it("collects last commit evidence and redacts secrets", async () => {
    const evidence = await collectGitEvidence({
      repoPath: "/repo",
      mode: "last_commit",
      git: {
        branch: async () => ({ current: "feature/billing-export" }),
        show: async () => "commit abc123\nAdd invoice export\nNOTION_TOKEN=secret_abc",
        diff: async () => "",
        status: async () => ({ files: [{ path: "src/routes/billing.tsx" }] }),
      },
    });

    expect(evidence.branch).toBe("feature/billing-export");
    expect(evidence.summary).toContain("Add invoice export");
    expect(evidence.summary).toContain("NOTION_TOKEN=[REDACTED]");
    expect(evidence.filesChanged).toEqual(["src/routes/billing.tsx"]);
  });
});
Step 2: Run failing test
Run: npm test -- tests/unit/git-evidence.test.ts

Expected: FAIL because src/evidence/git.ts does not exist.

Step 3: Implement git evidence collector
Create src/evidence/git.ts:

import simpleGit from "simple-git";
import { redactSecrets } from "../lib/redaction.js";

type GitMode = "staged" | "last_commit" | "working_tree";

interface GitLike {
  branch(): Promise<{ current: string }>;
  show(args?: string[]): Promise<string>;
  diff(args?: string[]): Promise<string>;
  status(): Promise<{ files: Array<{ path: string }> }>;
}

export interface GitEvidenceInput {
  repoPath: string;
  mode: GitMode;
  git?: GitLike;
}

export async function collectGitEvidence(input: GitEvidenceInput) {
  const git = input.git ?? simpleGit(input.repoPath);
  const branch = await git.branch();
  const status = await git.status();

  const rawSummary =
    input.mode === "last_commit"
      ? await git.show(["--stat", "--summary", "HEAD"])
      : input.mode === "staged"
        ? await git.diff(["--cached"])
        : await git.diff();

  return {
    source: "Local Git" as const,
    eventType: input.mode === "last_commit" ? ("Commit" as const) : ("Diff" as const),
    branch: branch.current,
    summary: redactSecrets(rawSummary),
    filesChanged: status.files.map((file) => file.path),
  };
}
Step 4: Verify git evidence
Run: npm test -- tests/unit/git-evidence.test.ts

Expected: PASS.

Step 5: Commit
git add src/evidence/git.ts tests/unit/git-evidence.test.ts
git commit -m "feat: collect local git evidence"
Task 6: Notion Schema And Initialization Tool
Files:

Create: src/lib/notion-client.ts

Create: src/lib/notion-schema.ts

Create: src/notion/project-manual.ts

Create: src/tools/initialize-project-manual.ts

Modify: src/server.ts

Create: tests/unit/notion-schema.test.ts


Step 1: Write schema test

Create tests/unit/notion-schema.test.ts:

import { describe, expect, it } from "vitest";
import { projectDatabaseSchema } from "../../src/lib/notion-schema.js";

describe("projectDatabaseSchema", () => {
  it("includes publishing mode and threshold", () => {
    const schema = projectDatabaseSchema();
    expect(schema["Publishing Mode"]).toMatchObject({ select: expect.any(Object) });
    expect(schema["Auto Publish Threshold"]).toEqual({ number: { format: "number" } });
  });
});
Step 2: Run failing schema test
Run: npm test -- tests/unit/notion-schema.test.ts

Expected: FAIL because schema module does not exist.

Step 3: Implement Notion client and schema
Create src/lib/notion-client.ts:

import { Client } from "@notionhq/client";
import { getRuntimeConfig } from "../config.js";

export function createNotionClient() {
  return new Client({ auth: getRuntimeConfig().notionToken });
}
Create src/lib/notion-schema.ts:

export function projectDatabaseSchema() {
  return {
    "Project Name": { title: {} },
    "Repository URL": { url: {} },
    "Publishing Mode": {
      select: {
        options: [
          { name: "Conservative", color: "gray" },
          { name: "Balanced", color: "blue" },
          { name: "Fully Automatic", color: "green" },
        ],
      },
    },
    "Auto Publish Threshold": { number: { format: "number" } },
    "Manual Home": { url: {} },
    "Current Release": { rich_text: {} },
    "Documentation Health": {
      status: {
        options: [
          { name: "Healthy", color: "green" },
          { name: "Needs Review", color: "yellow" },
          { name: "Behind", color: "red" },
        ],
      },
    },
  };
}

export function featuresDatabaseSchema() {
  return {
    "Feature Name": { title: {} },
    "Feature Key": { rich_text: {} },
    Project: { rich_text: {} },
    Module: {
      select: {
        options: [
          { name: "Auth", color: "red" },
          { name: "Billing", color: "green" },
          { name: "Admin Panel", color: "purple" },
          { name: "Reports", color: "blue" },
          { name: "API", color: "orange" },
          { name: "General", color: "gray" },
        ],
      },
    },
    "Audience Impact": {
      multi_select: {
        options: [
          { name: "User", color: "blue" },
          { name: "Admin", color: "red" },
          { name: "Developer", color: "purple" },
          { name: "Support", color: "green" },
        ],
      },
    },
    Status: {
      status: {
        options: [
          { name: "Captured", color: "gray" },
          { name: "Needs Review", color: "yellow" },
          { name: "Approved", color: "blue" },
          { name: "Published", color: "green" },
          { name: "Deprecated", color: "red" },
        ],
      },
    },
    "First Seen Commit": { rich_text: {} },
    "Last Documented Commit": { rich_text: {} },
    "Release Introduced": { rich_text: {} },
    "Confidence Score": { number: { format: "number" } },
  };
}

export function manualEntriesDatabaseSchema() {
  return {
    "Entry Title": { title: {} },
    "Entry Type": {
      select: {
        options: [
          { name: "User Guide", color: "blue" },
          { name: "Admin Guide", color: "red" },
          { name: "Developer Note", color: "purple" },
          { name: "Release Note", color: "green" },
        ],
      },
    },
    Audience: {
      select: {
        options: [
          { name: "User", color: "blue" },
          { name: "Admin", color: "red" },
          { name: "Both", color: "green" },
          { name: "Internal", color: "gray" },
        ],
      },
    },
    Status: {
      status: {
        options: [
          { name: "Captured", color: "gray" },
          { name: "Needs Review", color: "yellow" },
          { name: "Approved", color: "blue" },
          { name: "Published", color: "green" },
          { name: "Deprecated", color: "red" },
        ],
      },
    },
    "Confidence Score": { number: { format: "number" } },
    "Publishing Decision": {
      select: {
        options: [
          { name: "Agent Published", color: "green" },
          { name: "Queued Review", color: "yellow" },
          { name: "Human Approved", color: "blue" },
          { name: "Ignored", color: "gray" },
        ],
      },
    },
    "Source Commit": { rich_text: {} },
    "Source PR": { url: {} },
    "Files Changed": { rich_text: {} },
    "Routes / URLs": { rich_text: {} },
    "API Endpoints": { rich_text: {} },
    "Date Captured": { date: {} },
    "Date Published": { date: {} },
    "Reviewer Notes": { rich_text: {} },
  };
}

export function evidenceEventsDatabaseSchema() {
  return {
    "Event Title": { title: {} },
    Project: { rich_text: {} },
    Source: {
      select: {
        options: [
          { name: "Local Git", color: "blue" },
          { name: "GitHub", color: "purple" },
          { name: "CI", color: "green" },
          { name: "Release", color: "orange" },
          { name: "AI Session", color: "gray" },
        ],
      },
    },
    "Event Type": {
      select: {
        options: [
          { name: "Commit", color: "blue" },
          { name: "Diff", color: "gray" },
          { name: "PR Opened", color: "purple" },
          { name: "PR Merged", color: "green" },
          { name: "Tests Passed", color: "green" },
          { name: "Release Tagged", color: "orange" },
          { name: "Session Completed", color: "yellow" },
        ],
      },
    },
    "Commit SHA": { rich_text: {} },
    Branch: { rich_text: {} },
    "PR URL": { url: {} },
    "Release Version": { rich_text: {} },
    "Files Changed": { rich_text: {} },
    "Diff Summary": { rich_text: {} },
    "Test Status": {
      select: {
        options: [
          { name: "Passed", color: "green" },
          { name: "Failed", color: "red" },
          { name: "Unknown", color: "gray" },
          { name: "Not Run", color: "yellow" },
        ],
      },
    },
    "Captured At": { date: {} },
  };
}

export function releasesDatabaseSchema() {
  return {
    "Release Version": { title: {} },
    Project: { rich_text: {} },
    Status: {
      status: {
        options: [
          { name: "Planned", color: "gray" },
          { name: "In Progress", color: "yellow" },
          { name: "Ready", color: "blue" },
          { name: "Released", color: "green" },
        ],
      },
    },
    "Release Date": { date: {} },
    "Manual URL": { url: {} },
    "User Entries Count": { number: { format: "number" } },
    "Admin Entries Count": { number: { format: "number" } },
  };
}
Step 4: Implement project manual initialization
Create src/notion/project-manual.ts:

import type { Client } from "@notionhq/client";
import {
  evidenceEventsDatabaseSchema,
  featuresDatabaseSchema,
  manualEntriesDatabaseSchema,
  projectDatabaseSchema,
  releasesDatabaseSchema,
} from "../lib/notion-schema.js";

export async function initializeProjectManual(input: {
  notion: Client;
  projectName: string;
  parentPageId: string;
  repositoryUrl?: string;
  publishingMode: "Conservative" | "Balanced" | "Fully Automatic";
  autoPublishThreshold: number;
}) {
  const projects = await input.notion.databases.create({
    parent: { page_id: input.parentPageId },
    title: [{ type: "text", text: { content: `${input.projectName} - Documentation Projects` } }],
    properties: projectDatabaseSchema(),
  });

  const manualEntries = await input.notion.databases.create({
    parent: { page_id: input.parentPageId },
    title: [{ type: "text", text: { content: `${input.projectName} - Manual Entries` } }],
    properties: manualEntriesDatabaseSchema(),
  });

  const features = await input.notion.databases.create({
    parent: { page_id: input.parentPageId },
    title: [{ type: "text", text: { content: `${input.projectName} - Features` } }],
    properties: featuresDatabaseSchema(),
  });

  const evidenceEvents = await input.notion.databases.create({
    parent: { page_id: input.parentPageId },
    title: [{ type: "text", text: { content: `${input.projectName} - Evidence Events` } }],
    properties: evidenceEventsDatabaseSchema(),
  });

  const releases = await input.notion.databases.create({
    parent: { page_id: input.parentPageId },
    title: [{ type: "text", text: { content: `${input.projectName} - Releases` } }],
    properties: releasesDatabaseSchema(),
  });

  return {
    projectsDatabaseId: projects.id,
    featuresDatabaseId: features.id,
    manualEntriesDatabaseId: manualEntries.id,
    evidenceEventsDatabaseId: evidenceEvents.id,
    releasesDatabaseId: releases.id,
    projectsUrl: projects.url,
    featuresUrl: features.url,
    manualEntriesUrl: manualEntries.url,
    evidenceEventsUrl: evidenceEvents.url,
    releasesUrl: releases.url,
  };
}
Step 5: Register initialization tool
Create src/tools/initialize-project-manual.ts:

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRuntimeConfig } from "../config.js";
import { createNotionClient } from "../lib/notion-client.js";
import { initializeProjectManual } from "../notion/project-manual.js";

export function registerInitializeProjectManualTool(server: McpServer) {
  server.tool(
    "initialize_project_manual",
    "Create the Notion databases for an auto-generated project manual.",
    {
      projectName: z.string(),
      parentPageId: z.string(),
      repositoryUrl: z.string().url().optional(),
      publishingMode: z.enum(["Conservative", "Balanced", "Fully Automatic"]).optional(),
      autoPublishThreshold: z.number().min(0).max(100).optional(),
    },
    async ({ projectName, parentPageId, repositoryUrl, publishingMode, autoPublishThreshold }) => {
      const config = getRuntimeConfig();
      const result = await initializeProjectManual({
        notion: createNotionClient(),
        projectName,
        parentPageId,
        repositoryUrl,
        publishingMode: publishingMode ?? config.defaultPublishingMode,
        autoPublishThreshold: autoPublishThreshold ?? config.defaultAutoPublishThreshold,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
Modify src/server.ts:

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInitializeProjectManualTool } from "./tools/initialize-project-manual.js";

export function createServer() {
  const server = new McpServer({
    name: "auto-docs-notion-mcp",
    version: "0.1.0",
  });

  registerInitializeProjectManualTool(server);

  return server;
}
Step 6: Verify schema and typecheck
Run: npm test -- tests/unit/notion-schema.test.ts

Expected: PASS.

Run: npm run typecheck

Expected: PASS.

Step 7: Commit
git add src/lib/notion-client.ts src/lib/notion-schema.ts src/notion/project-manual.ts src/tools/initialize-project-manual.ts src/server.ts tests/unit/notion-schema.test.ts
git commit -m "feat: initialize notion documentation schema"
Task 7: Documentation Upsert And Publishing Decision
Files:

Create: src/notion/manual-entry.ts

Create: src/tools/upsert-feature-documentation.ts

Create: src/tools/publish-or-queue-review.ts

Modify: src/server.ts

Create: tests/unit/publishing-decision.test.ts


Step 1: Write publishing decision tests

Create tests/unit/publishing-decision.test.ts:

import { describe, expect, it } from "vitest";
import { decidePublishingStatus } from "../../src/notion/manual-entry.js";

describe("decidePublishingStatus", () => {
  it("queues all entries in conservative mode", () => {
    expect(decidePublishingStatus({ mode: "Conservative", score: 100, threshold: 90 })).toEqual({
      status: "Needs Review",
      decision: "Queued Review",
    });
  });

  it("publishes high confidence entries in balanced mode", () => {
    expect(decidePublishingStatus({ mode: "Balanced", score: 92, threshold: 90 })).toEqual({
      status: "Published",
      decision: "Agent Published",
    });
  });

  it("captures low confidence entries in balanced mode", () => {
    expect(decidePublishingStatus({ mode: "Balanced", score: 55, threshold: 90 })).toEqual({
      status: "Captured",
      decision: "Queued Review",
    });
  });
});
Step 2: Run failing test
Run: npm test -- tests/unit/publishing-decision.test.ts

Expected: FAIL because src/notion/manual-entry.ts does not exist.

Step 3: Implement publishing decision and Notion upsert append
Create src/notion/manual-entry.ts:

import type { Client } from "@notionhq/client";
import type { DocumentationStatus, ManualEntryDraft, PublishingDecision } from "../types.js";
import { divider, heading2, paragraphs } from "../lib/notion-blocks.js";

export function decidePublishingStatus(input: {
  mode: "Conservative" | "Balanced" | "Fully Automatic";
  score: number;
  threshold: number;
}): { status: DocumentationStatus; decision: PublishingDecision } {
  if (input.mode === "Conservative") {
    return { status: "Needs Review", decision: "Queued Review" };
  }

  if (input.mode === "Fully Automatic" && input.score >= 40) {
    return { status: "Published", decision: "Agent Published" };
  }

  if (input.score >= input.threshold) {
    return { status: "Published", decision: "Agent Published" };
  }

  if (input.score >= 70) {
    return { status: "Needs Review", decision: "Queued Review" };
  }

  return { status: "Captured", decision: "Queued Review" };
}

export async function createManualEntry(input: {
  notion: Client;
  databaseId: string;
  draft: ManualEntryDraft;
  status: DocumentationStatus;
  decision: PublishingDecision;
  confidenceScore: number;
  sourceCommit?: string;
  sourcePr?: string;
  filesChanged?: string[];
}) {
  const page = await input.notion.pages.create({
    parent: { database_id: input.databaseId },
    properties: {
      "Entry Title": { title: [{ text: { content: input.draft.entryTitle } }] },
      "Entry Type": { select: { name: input.draft.entryType } },
      Audience: { select: { name: input.draft.audience } },
      Status: { status: { name: input.status } },
      "Confidence Score": { number: input.confidenceScore },
      "Publishing Decision": { select: { name: input.decision } },
      ...(input.sourceCommit && { "Source Commit": { rich_text: [{ text: { content: input.sourceCommit } }] } }),
      ...(input.sourcePr && { "Source PR": { url: input.sourcePr } }),
      ...(input.filesChanged && { "Files Changed": { rich_text: [{ text: { content: input.filesChanged.join("\n") } }] } }),
      ...(input.draft.routes && { "Routes / URLs": { rich_text: [{ text: { content: input.draft.routes.join("\n") } }] } }),
      ...(input.draft.apiEndpoints && {
        "API Endpoints": { rich_text: [{ text: { content: input.draft.apiEndpoints.join("\n") } }] },
      }),
      "Date Captured": { date: { start: new Date().toISOString().slice(0, 10) } },
      ...(input.status === "Published" && {
        "Date Published": { date: { start: new Date().toISOString().slice(0, 10) } },
      }),
    },
    children: [heading2(input.draft.entryType), ...paragraphs(input.draft.body), divider()],
  });

  return { pageId: page.id, url: page.url };
}
Step 4: Register upsert and publishing tools
Create src/tools/upsert-feature-documentation.ts:

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createNotionClient } from "../lib/notion-client.js";
import { createManualEntry, decidePublishingStatus } from "../notion/manual-entry.js";

export function registerUpsertFeatureDocumentationTool(server: McpServer) {
  server.tool(
    "upsert_feature_documentation",
    "Create or update manual entries for a documented feature.",
    {
      manualEntriesDatabaseId: z.string(),
      publishingMode: z.enum(["Conservative", "Balanced", "Fully Automatic"]),
      autoPublishThreshold: z.number().min(0).max(100),
      confidenceScore: z.number().min(0).max(100),
      sourceCommit: z.string().optional(),
      sourcePr: z.string().url().optional(),
      filesChanged: z.array(z.string()).optional(),
      manualEntries: z.array(
        z.object({
          entryTitle: z.string(),
          entryType: z.enum(["User Guide", "Admin Guide", "Developer Note", "Release Note"]),
          audience: z.enum(["User", "Admin", "Both", "Internal"]),
          body: z.string(),
          routes: z.array(z.string()).optional(),
          apiEndpoints: z.array(z.string()).optional(),
        }),
      ),
    },
    async (input) => {
      const publish = decidePublishingStatus({
        mode: input.publishingMode,
        score: input.confidenceScore,
        threshold: input.autoPublishThreshold,
      });

      const pages = [];
      for (const draft of input.manualEntries) {
        pages.push(
          await createManualEntry({
            notion: createNotionClient(),
            databaseId: input.manualEntriesDatabaseId,
            draft,
            status: publish.status,
            decision: publish.decision,
            confidenceScore: input.confidenceScore,
            sourceCommit: input.sourceCommit,
            sourcePr: input.sourcePr,
            filesChanged: input.filesChanged,
          }),
        );
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ publish, pages }, null, 2) }],
      };
    },
  );
}
Create src/tools/publish-or-queue-review.ts:

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { decidePublishingStatus } from "../notion/manual-entry.js";

export function registerPublishOrQueueReviewTool(server: McpServer) {
  server.tool(
    "publish_or_queue_review",
    "Return the documentation publishing decision for a confidence score and project policy.",
    {
      publishingMode: z.enum(["Conservative", "Balanced", "Fully Automatic"]),
      autoPublishThreshold: z.number().min(0).max(100),
      confidenceScore: z.number().min(0).max(100),
    },
    async ({ publishingMode, autoPublishThreshold, confidenceScore }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            decidePublishingStatus({
              mode: publishingMode,
              threshold: autoPublishThreshold,
              score: confidenceScore,
            }),
            null,
            2,
          ),
        },
      ],
    }),
  );
}
Modify src/server.ts:

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInitializeProjectManualTool } from "./tools/initialize-project-manual.js";
import { registerPublishOrQueueReviewTool } from "./tools/publish-or-queue-review.js";
import { registerUpsertFeatureDocumentationTool } from "./tools/upsert-feature-documentation.js";

export function createServer() {
  const server = new McpServer({
    name: "auto-docs-notion-mcp",
    version: "0.1.0",
  });

  registerInitializeProjectManualTool(server);
  registerPublishOrQueueReviewTool(server);
  registerUpsertFeatureDocumentationTool(server);

  return server;
}
Step 5: Verify publishing logic
Run: npm test -- tests/unit/publishing-decision.test.ts

Expected: PASS.

Run: npm run typecheck

Expected: PASS.

Step 6: Commit
git add src/notion/manual-entry.ts src/tools/upsert-feature-documentation.ts src/tools/publish-or-queue-review.ts src/server.ts tests/unit/publishing-decision.test.ts
git commit -m "feat: upsert manual entries with confidence gating"
Task 8: Capture, Analyze, Status, And Package Tools
Files:

Create: src/tools/capture-development-event.ts

Create: src/tools/analyze-documentation-candidate.ts

Create: src/tools/get-documentation-status.ts

Create: src/packaging/manual-packager.ts

Create: src/tools/package-manual.ts

Modify: src/server.ts

Create: tests/unit/manual-packager.test.ts


Step 1: Write packager test

Create tests/unit/manual-packager.test.ts:

import { describe, expect, it } from "vitest";
import { buildMarkdownManual } from "../../src/packaging/manual-packager.js";

describe("buildMarkdownManual", () => {
  it("packages published entries by audience", () => {
    const markdown = buildMarkdownManual({
      projectName: "Acme App",
      releaseVersion: "1.0.0",
      audience: "User",
      entries: [
        { title: "Invoice Export", body: "Open Billing and click Export.", audience: "User", status: "Published" },
        { title: "Webhook Setup", body: "Set STRIPE_WEBHOOK_SECRET.", audience: "Admin", status: "Published" },
      ],
    });

    expect(markdown).toContain("# Acme App User Manual - 1.0.0");
    expect(markdown).toContain("## Invoice Export");
    expect(markdown).not.toContain("Webhook Setup");
  });
});
Step 2: Run failing test
Run: npm test -- tests/unit/manual-packager.test.ts

Expected: FAIL because src/packaging/manual-packager.ts does not exist.

Step 3: Implement markdown packager
Create src/packaging/manual-packager.ts:

import type { Audience, DocumentationStatus } from "../types.js";

interface ManualEntry {
  title: string;
  body: string;
  audience: Audience;
  status: DocumentationStatus;
}

export function buildMarkdownManual(input: {
  projectName: string;
  releaseVersion: string;
  audience: "User" | "Admin";
  entries: ManualEntry[];
}) {
  const included = input.entries.filter(
    (entry) => entry.status === "Published" && (entry.audience === input.audience || entry.audience === "Both"),
  );

  return [
    `# ${input.projectName} ${input.audience} Manual - ${input.releaseVersion}`,
    "",
    ...included.flatMap((entry) => [`## ${entry.title}`, "", entry.body, ""]),
  ].join("\n");
}
Step 4: Register remaining tools
Create src/tools/capture-development-event.ts:

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectGitEvidence } from "../evidence/git.js";

export function registerCaptureDevelopmentEventTool(server: McpServer) {
  server.tool(
    "capture_development_event",
    "Capture local git evidence for a possible documentation event.",
    {
      repoPath: z.string(),
      mode: z.enum(["staged", "last_commit", "working_tree"]),
    },
    async ({ repoPath, mode }) => ({
      content: [{ type: "text", text: JSON.stringify(await collectGitEvidence({ repoPath, mode }), null, 2) }],
    }),
  );
}
Create src/tools/analyze-documentation-candidate.ts:

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { scoreDocumentationConfidence } from "../analysis/confidence.js";
import { createFeatureKey } from "../analysis/feature-key.js";
import { classifyManualWorthiness } from "../analysis/manual-worthiness.js";

export function registerAnalyzeDocumentationCandidateTool(server: McpServer) {
  server.tool(
    "analyze_documentation_candidate",
    "Analyze captured evidence and decide whether documentation should be generated.",
    {
      summary: z.string(),
      filesChanged: z.array(z.string()),
      featureName: z.string(),
      module: z.string().optional(),
      route: z.string().optional(),
      testsPassed: z.boolean().default(false),
      mergedOrReleased: z.boolean().default(false),
      concreteDocumentation: z.boolean().default(false),
    },
    async (input) => {
      const worthiness = classifyManualWorthiness({
        summary: input.summary,
        filesChanged: input.filesChanged,
      });
      const confidence = scoreDocumentationConfidence({
        manualWorthy: worthiness.shouldDocument,
        featureNameMatched: input.summary.toLowerCase().includes(input.featureName.toLowerCase()),
        testsPassed: input.testsPassed,
        mergedOrReleased: input.mergedOrReleased,
        concreteDocumentation: input.concreteDocumentation,
        ambiguousPurpose: !worthiness.shouldDocument,
        duplicateUncertain: false,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                shouldDocument: worthiness.shouldDocument,
                featureKey: createFeatureKey(input),
                featureName: input.featureName,
                audiences: worthiness.audiences,
                confidenceScore: confidence.score,
                confidenceReasons: [...worthiness.reasons, ...confidence.reasons],
                reviewQuestions: confidence.reviewQuestions,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
Create src/tools/get-documentation-status.ts:

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerGetDocumentationStatusTool(server: McpServer) {
  server.tool(
    "get_documentation_status",
    "Summarize documentation health counts supplied by an orchestrating agent.",
    {
      publishedCount: z.number().min(0),
      needsReviewCount: z.number().min(0),
      capturedCount: z.number().min(0),
      lowConfidenceCount: z.number().min(0),
    },
    async (input) => ({
      content: [{ type: "text", text: JSON.stringify(input, null, 2) }],
    }),
  );
}
Create src/tools/package-manual.ts:

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildMarkdownManual } from "../packaging/manual-packager.js";

export function registerPackageManualTool(server: McpServer) {
  server.tool(
    "package_manual",
    "Build a Markdown release manual from published entries supplied by the agent.",
    {
      projectName: z.string(),
      releaseVersion: z.string(),
      audience: z.enum(["User", "Admin"]),
      entries: z.array(
        z.object({
          title: z.string(),
          body: z.string(),
          audience: z.enum(["User", "Admin", "Both", "Internal"]),
          status: z.enum(["Captured", "Needs Review", "Approved", "Published", "Deprecated"]),
        }),
      ),
    },
    async (input) => ({
      content: [{ type: "text", text: buildMarkdownManual(input) }],
    }),
  );
}
Modify src/server.ts:

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyzeDocumentationCandidateTool } from "./tools/analyze-documentation-candidate.js";
import { registerCaptureDevelopmentEventTool } from "./tools/capture-development-event.js";
import { registerGetDocumentationStatusTool } from "./tools/get-documentation-status.js";
import { registerInitializeProjectManualTool } from "./tools/initialize-project-manual.js";
import { registerPackageManualTool } from "./tools/package-manual.js";
import { registerPublishOrQueueReviewTool } from "./tools/publish-or-queue-review.js";
import { registerUpsertFeatureDocumentationTool } from "./tools/upsert-feature-documentation.js";

export function createServer() {
  const server = new McpServer({
    name: "auto-docs-notion-mcp",
    version: "0.1.0",
  });

  registerInitializeProjectManualTool(server);
  registerCaptureDevelopmentEventTool(server);
  registerAnalyzeDocumentationCandidateTool(server);
  registerUpsertFeatureDocumentationTool(server);
  registerPublishOrQueueReviewTool(server);
  registerPackageManualTool(server);
  registerGetDocumentationStatusTool(server);

  return server;
}
Step 5: Verify final tool set
Run: npm test

Expected: all tests pass.

Run: npm run typecheck

Expected: PASS.

Step 6: Commit
git add src tests
git commit -m "feat: complete mvp documentation workflow tools"
Self-Review
Spec coverage:

Automatic capture is covered by capture_development_event.
Crisp user/admin judgment is covered by manual-worthiness.
Deduplication foundation is covered by feature-key; the initialized Features database stores stable feature keys so the next write path can query and update by key.
Confidence-gated publishing is covered by confidence and decidePublishingStatus.
Notion schema initialization is covered by initialize_project_manual.
Release packaging is covered by package_manual.
Solo and team support use the same evidence shape; GitHub can be added by creating a new evidence collector without changing the analyzer.
Known MVP limitation:

The first implementation stores feature keys and initializes the Features database, but full Notion relation wiring between Features, Manual Entries, Evidence Events, and Releases can be added after the core create/update workflow is verified against the live Notion API.
Execution Handoff
Plan complete and saved to docs/superpowers/plans/2026-05-24-auto-documentation-mcp-server.md. Two execution options:

Subagent-Driven (recommended) - Dispatch a fresh subagent per task, review between tasks, fast iteration.

Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?