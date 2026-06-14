import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../src/lib/state-store.js";

const testContext = vi.hoisted(() => ({
  notion: null as ReturnType<typeof createFakeNotion> | null,
  store: null as StateStore | null,
  pdfCalls: [] as Array<{ markdown: string; outputPath: string; title: string }>,
  providerCalls: 0,
  storedApiKeys: [] as Array<{ providerType: string; apiKey: string }>,
  providerHealthy: true,
}));

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => {
    if (!testContext.notion) {
      throw new Error("Test Notion client not initialized");
    }

    return testContext.notion;
  },
}));

vi.mock("../../src/lib/state-store.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/state-store.js")>("../../src/lib/state-store.js");
  return {
    ...actual,
    getStateStore: () => {
      if (!testContext.store) {
        throw new Error("Test store not initialized");
      }

      return testContext.store;
    },
  };
});

vi.mock("../../src/lib/pdf.js", () => ({
  generatePdfFromMarkdown: vi.fn(async (input: { markdown: string; outputPath: string; title: string }) => {
    testContext.pdfCalls.push(input);
    return input.outputPath;
  }),
}));

vi.mock("../../src/providers/factory.js", () => ({
  resetProvider: vi.fn(),
  buildCandidate: vi.fn(() => ({
    id: "test-provider",
    displayName: "Test Provider",
    supportsEmbeddings: false,
    healthCheck: vi.fn(async () => testContext.providerHealthy),
    analyze: vi.fn(),
  })),
  analyzeWithFallback: vi.fn(async () => {
    testContext.providerCalls += 1;
    return {
      featureName: "Release Notes",
      featureKey: "provider:release-notes",
      shouldDocument: true,
      audiences: ["User"],
      userGuide: {
        summary: "Users receive the release changes documented in this manual update.",
        steps: ["Open the updated application", "Review the release notes", "Use the documented workflow"],
        expectedOutcome: "Release documentation is available to users.",
        possibleErrors: [],
      },
      adminGuide: {
        configRequired: ["No new configuration required"],
        endpointsAffected: [],
        envVarsRequired: [],
        verificationSteps: ["Confirm the release manual exports successfully"],
        troubleshooting: [],
      },
      confidenceScore: 85,
      confidenceReasons: ["Provider generated release documentation."],
      reviewQuestions: [],
      providerUsed: "test-provider",
      generationMs: 1,
    };
  }),
  embedText: vi.fn(async () => [1, 0, 0]),
}));

vi.mock("../../src/installer/token-store.js", () => ({
  storeApiKey: vi.fn(async (providerType: string, apiKey: string) => {
    testContext.storedApiKeys.push({ providerType, apiKey });
    return "env-file";
  }),
}));

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

type FakePage = {
  id: string;
  parent: { database_id: string };
  properties: Record<string, unknown>;
  children: Array<{ type: "paragraph"; paragraph: { rich_text: Array<{ plain_text: string }> } }>;
  url?: string;
};

function titleProperty(value: string) {
  return { title: [{ text: { content: value }, plain_text: value }] };
}

function selectProperty(value: string) {
  return { select: { name: value } };
}

function statusProperty(value: string) {
  return { status: { name: value } };
}

function relationProperty(...ids: string[]) {
  return { relation: ids.map((id) => ({ id })) };
}

function richTextProperty(value: string) {
  return { rich_text: [{ text: { content: value }, plain_text: value }] };
}

function paragraph(text: string): FakePage["children"][number] {
  return { type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } };
}

function textFromTitle(property: unknown): string | undefined {
  return (property as { title?: Array<{ text?: { content?: string } }> } | undefined)?.title?.[0]?.text?.content;
}

function textFromStatus(property: unknown): string | undefined {
  return (property as { status?: { name?: string } } | undefined)?.status?.name;
}

function relationIds(property: unknown): string[] {
  return ((property as { relation?: Array<{ id?: string }> } | undefined)?.relation ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string");
}

function clauseMatches(page: FakePage, clause: Record<string, unknown>): boolean {
  if ("or" in clause && Array.isArray(clause.or)) {
    return clause.or.some((item) => clauseMatches(page, item as Record<string, unknown>));
  }

  if ("and" in clause && Array.isArray(clause.and)) {
    return clause.and.every((item) => clauseMatches(page, item as Record<string, unknown>));
  }

  const propertyName = clause.property;
  if (typeof propertyName !== "string") {
    return true;
  }

  const property = page.properties[propertyName];
  if ("relation" in clause) {
    const expected = (clause.relation as { contains?: string }).contains;
    return typeof expected !== "string" || relationIds(property).includes(expected);
  }

  if ("title" in clause) {
    const expected = (clause.title as { equals?: string }).equals;
    return typeof expected !== "string" || textFromTitle(property) === expected;
  }

  if ("status" in clause) {
    const expected = (clause.status as { equals?: string }).equals;
    return typeof expected !== "string" || textFromStatus(property) === expected;
  }

  return true;
}

function createFakeNotion() {
  let counter = 0;
  const pages = new Map<string, FakePage>();

  function addPage(page: FakePage) {
    pages.set(page.id, page);
    return page;
  }

  function nextId(prefix: string) {
    counter += 1;
    return `${prefix}_${counter}`;
  }

  return {
    _pages: pages,
    _addPage: addPage,
    users: { me: vi.fn(async () => ({ id: "user_1" })) },
    databases: {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({ id: database_id })),
      query: vi.fn(async (input: { database_id: string; filter?: Record<string, unknown>; page_size?: number }) => {
        const results = Array.from(pages.values()).filter((page) => {
          if (page.parent.database_id !== input.database_id) {
            return false;
          }

          return input.filter ? clauseMatches(page, input.filter) : true;
        });

        return {
          results: results.slice(0, input.page_size ?? results.length).map((page) => ({
            id: page.id,
            properties: page.properties,
            url: page.url,
          })),
          has_more: false,
          next_cursor: null,
        };
      }),
    },
    pages: {
      create: vi.fn(async (input: { parent: { database_id: string }; properties: Record<string, unknown>; children?: FakePage["children"] }) => {
        const id = nextId("page");
        const page = addPage({
          id,
          parent: input.parent,
          properties: { ...input.properties },
          children: input.children ?? [],
          url: `https://notion.local/${id}`,
        });
        return { id: page.id, url: page.url };
      }),
      update: vi.fn(async (input: { page_id: string; properties: Record<string, unknown>; children?: FakePage["children"] }) => {
        const page = pages.get(input.page_id);
        if (!page) {
          throw new Error(`Missing page ${input.page_id}`);
        }

        page.properties = { ...page.properties, ...input.properties };
        if (input.children) {
          page.children = input.children;
        }

        return { id: page.id, url: page.url };
      }),
    },
    blocks: {
      children: {
        list: vi.fn(async ({ block_id }: { block_id: string }) => ({
          results: pages.get(block_id)?.children ?? [],
          has_more: false,
          next_cursor: null,
        })),
      },
    },
  };
}

function parseTool<T>(value: ToolResult): T {
  return JSON.parse(value.content[0].text) as T;
}

async function setupProject() {
  const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-export-release-"));
  const store = new StateStore(join(stateDir, "state.json"));
  const notion = createFakeNotion();

  await store.upsertProject({
    projectId: "project_1",
    projectName: "Acme App",
    parentPageId: "parent_1",
    publishingMode: "Balanced",
    autoPublishThreshold: 60,
    projectPageId: "project_page_1",
    databases: {
      projectsDatabaseId: "projects_db",
      featuresDatabaseId: "features_db",
      manualEntriesDatabaseId: "manual_db",
      evidenceEventsDatabaseId: "events_db",
      releasesDatabaseId: "releases_db",
    },
    featuresByKey: {},
    eventsByExternalId: {},
    eventSnapshots: {},
  });

  notion._addPage({
    id: "release_1",
    parent: { database_id: "releases_db" },
    properties: {
      "Release Version": titleProperty("1.2.3"),
      Project: relationProperty("project_page_1"),
      Status: statusProperty("Ready"),
    },
    children: [],
    url: "https://notion.local/release_1",
  });

  notion._addPage({
    id: "manual_user_1",
    parent: { database_id: "manual_db" },
    properties: {
      "Entry Title": titleProperty("Billing Export"),
      "Entry Type": selectProperty("User Guide"),
      Audience: selectProperty("User"),
      Status: statusProperty("Published"),
      "Confidence Score": { number: 91 },
      "Source PR": { url: "https://github.com/acme/app/pull/42" },
      Project: relationProperty("project_page_1"),
      Release: relationProperty("release_1"),
      Feature: relationProperty("feature_1"),
    },
    children: [paragraph("Users can export invoices from billing settings.")],
  });

  notion._addPage({
    id: "manual_admin_1",
    parent: { database_id: "manual_db" },
    properties: {
      "Entry Title": titleProperty("Billing Admin Controls"),
      "Entry Type": selectProperty("Admin Guide"),
      Audience: selectProperty("Admin"),
      Status: statusProperty("Approved"),
      "Confidence Score": { number: 83 },
      Project: relationProperty("project_page_1"),
      Release: relationProperty("release_1"),
      Feature: relationProperty("feature_2"),
    },
    children: [paragraph("Admins can verify billing export permissions.")],
  });

  testContext.store = store;
  testContext.notion = notion;
  return { stateDir, store, notion };
}

async function handlerFor(register: (server: McpServer) => void, name: string): Promise<ToolHandler> {
  const server = new FakeServer();
  register(server as unknown as McpServer);
  const handler = server.handlers.get(name);
  expect(handler).toBeDefined();
  return handler!;
}

beforeEach(() => {
  testContext.notion = null;
  testContext.store = null;
  testContext.pdfCalls = [];
  testContext.providerCalls = 0;
  testContext.storedApiKeys = [];
  testContext.providerHealthy = true;
});

afterEach(() => {
  delete process.env.AI_PROVIDER_TYPE;
  delete process.env.AI_ENDPOINT;
  delete process.env.AI_MODEL_NAME;
  delete process.env.AI_API_KEY;
});

describe("export and release tools", () => {
  it("exports manual PDF, help center JSON, local docs, changelog, and PR preview", async () => {
    const { stateDir } = await setupProject();
    const { registerExportManualPdfTool } = await import("../../src/tools/export-manual-pdf.js");
    const { registerExportHelpCenterContentTool } = await import("../../src/tools/export-help-center-content.js");
    const { registerSyncManualToLocalDocsTool } = await import("../../src/tools/sync-manual-to-local-docs.js");
    const { registerGenerateReleaseChangelogTool } = await import("../../src/tools/generate-release-changelog.js");
    const { registerGeneratePrCommentPreviewTool } = await import("../../src/tools/generate-pr-comment-preview.js");
    const { registerPublishPrCommentTool } = await import("../../src/tools/publish-pr-comment.js");

    const pdf = await handlerFor(registerExportManualPdfTool, "export_manual_pdf");
    const help = await handlerFor(registerExportHelpCenterContentTool, "export_help_center_content");
    const sync = await handlerFor(registerSyncManualToLocalDocsTool, "sync_manual_to_local_docs");
    const changelog = await handlerFor(registerGenerateReleaseChangelogTool, "generate_release_changelog");
    const preview = await handlerFor(registerGeneratePrCommentPreviewTool, "generate_pr_comment_preview");
    const publish = await handlerFor(registerPublishPrCommentTool, "publish_pr_comment");

    const pdfResult = parseTool<{ includedEntryCount: number; outputPath: string }>(
      await pdf({ projectId: "project_1", releaseVersion: "1.2.3", audience: "both", outputPath: join(stateDir, "manual.pdf") }),
    );
    expect(pdfResult.includedEntryCount).toBe(2);
    expect(pdfResult.outputPath).toContain("manual.pdf");
    expect(testContext.pdfCalls).toHaveLength(1);

    const helpPath = join(stateDir, "help.json");
    const helpResult = parseTool<{ articleCount: number; outputPath: string }>(
      await help({ projectId: "project_1", releaseVersion: "1.2.3", audience: "both", outputPath: helpPath }),
    );
    expect(helpResult.articleCount).toBe(1);
    expect(JSON.parse(await readFile(helpPath, "utf8")).articleCount).toBe(1);

    const docsPath = join(stateDir, "MANUAL.md");
    const syncResult = parseTool<{ entryCount: number; outputPath: string; byteLength: number }>(
      await sync({ projectId: "project_1", releaseVersion: "1.2.3", audience: "both", outputPath: docsPath }),
    );
    expect(syncResult.entryCount).toBe(1);
    expect(syncResult.byteLength).toBeGreaterThan(0);
    expect(await readFile(docsPath, "utf8")).toContain("Billing Export");

    const changelogResult = parseTool<{ entryCount: number; changelogMarkdown: string }>(
      await changelog({ projectId: "project_1", releaseVersion: "1.2.3" }),
    );
    expect(changelogResult.entryCount).toBe(2);
    expect(changelogResult.changelogMarkdown).toContain("Billing Export");

    const previewResult = parseTool<{ entryCount: number; markdownPreview: string }>(
      await preview({ projectId: "project_1", audience: "user", prUrl: "https://github.com/acme/app/pull/42" }),
    );
    expect(previewResult.entryCount).toBe(1);
    expect(previewResult.markdownPreview).toContain("Auto-Documentation Preview");

    const publishResult = parseTool<{ dryRun: boolean; action: string; entryCount: number; commentBody: string }>(
      await publish({ projectId: "project_1", audience: "user", prUrl: "https://github.com/acme/app/pull/42", dryRun: true }),
    );
    expect(publishResult.dryRun).toBe(true);
    expect(publishResult.action).toBe("none");
    expect(publishResult.entryCount).toBe(1);
    expect(publishResult.commentBody).toContain("<!-- auto-doc-pr-comment project=project_1 -->");
    expect(publishResult.commentBody).toContain("Auto-Documentation Preview");
  });

  it("returns failure envelopes for missing project input", async () => {
    await setupProject();
    const { registerExportManualPdfTool } = await import("../../src/tools/export-manual-pdf.js");
    const { registerExportHelpCenterContentTool } = await import("../../src/tools/export-help-center-content.js");
    const { registerSyncManualToLocalDocsTool } = await import("../../src/tools/sync-manual-to-local-docs.js");
    const { registerGenerateReleaseChangelogTool } = await import("../../src/tools/generate-release-changelog.js");
    const { registerGeneratePrCommentPreviewTool } = await import("../../src/tools/generate-pr-comment-preview.js");
    const { registerPublishPrCommentTool } = await import("../../src/tools/publish-pr-comment.js");

    const cases: Array<{
      register: (server: McpServer) => void;
      name: string;
      input: Record<string, unknown>;
      code: string;
    }> = [
      {
        register: registerExportManualPdfTool,
        name: "export_manual_pdf",
        input: { projectId: "missing", releaseVersion: "1.2.3", outputPath: "manual.pdf" },
        code: "EXPORT_MANUAL_PDF_FAILED",
      },
      {
        register: registerExportHelpCenterContentTool,
        name: "export_help_center_content",
        input: { projectId: "missing", audience: "both" },
        code: "EXPORT_HELP_CENTER_CONTENT_FAILED",
      },
      {
        register: registerSyncManualToLocalDocsTool,
        name: "sync_manual_to_local_docs",
        input: { projectId: "missing", audience: "both", outputPath: "MANUAL.md" },
        code: "SYNC_MANUAL_TO_LOCAL_DOCS_FAILED",
      },
      {
        register: registerGenerateReleaseChangelogTool,
        name: "generate_release_changelog",
        input: { projectId: "missing", releaseVersion: "1.2.3" },
        code: "GENERATE_RELEASE_CHANGELOG_FAILED",
      },
      {
        register: registerGeneratePrCommentPreviewTool,
        name: "generate_pr_comment_preview",
        input: { projectId: "missing", audience: "both" },
        code: "GENERATE_PR_COMMENT_PREVIEW_FAILED",
      },
      {
        register: registerPublishPrCommentTool,
        name: "publish_pr_comment",
        input: { projectId: "missing", prUrl: "https://github.com/acme/app/pull/42", audience: "both", dryRun: true },
        code: "PUBLISH_PR_COMMENT_FAILED",
      },
    ];

    for (const testCase of cases) {
      const handler = await handlerFor(testCase.register, testCase.name);
      await expect(handler(testCase.input)).rejects.toMatchObject({
        name: "McpToolError",
        envelope: {
          ok: false,
          error: {
            code: testCase.code,
            tool: testCase.name,
          },
        },
      });
    }
  });

  it("configures AI provider without persisting secrets in the response", async () => {
    const cwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), "auto-doc-configure-provider-"));
    const { registerConfigureAiProviderTool } = await import("../../src/tools/configure-ai-provider.js");
    const configure = await handlerFor(registerConfigureAiProviderTool, "configure_ai_provider");

    try {
      process.chdir(tempDir);
      const result = parseTool<{ providerType: string; healthy: boolean; endpoint: string; modelName: string }>(
        await configure({
          providerType: "cloud-openai",
          endpoint: "https://api.openai.test/v1",
          modelName: "gpt-test",
          apiKey: "secret-test-key",
          runHealthCheck: true,
        }),
      );

      expect(result.providerType).toBe("cloud-openai");
      expect(result.healthy).toBe(true);
      expect(JSON.stringify(result)).not.toContain("secret-test-key");
      expect(testContext.storedApiKeys).toEqual([{ providerType: "cloud-openai", apiKey: "secret-test-key" }]);
      expect(await readFile(join(tempDir, ".env"), "utf8")).toContain("AI_PROVIDER_TYPE=cloud-openai");
    } finally {
      process.chdir(cwd);
    }
  });

  it("runs release pipeline through trigger, changelog, package, PDF, sync, and help-center steps", async () => {
    const { stateDir, notion } = await setupProject();
    const { registerRunReleaseDocumentationPipelineTool } = await import("../../src/tools/run-release-documentation-pipeline.js");
    const pipeline = await handlerFor(registerRunReleaseDocumentationPipelineTool, "run_release_documentation_pipeline");

    const result = parseTool<{
      trigger: { disposition: string; capture: { evidenceEventId: string } };
      changelog: { entryCount: number };
      package: { releasePageId: string };
      pdf: { outputPath: string };
      sync: { outputPath: string };
      helpCenter: { outputPath: string; articleCount: number };
    }>(
      await pipeline({
        projectId: "project_1",
        releaseVersion: "2.0.0",
        repoPath: "C:/repo",
        mode: "last_commit",
        audience: "both",
        packageFormat: "markdown",
        pdfOutputPath: join(stateDir, "release.pdf"),
        localDocsOutputPath: join(stateDir, "release.md"),
        helpCenterOutputPath: join(stateDir, "release-help.json"),
      }),
    );

    expect(result.trigger.disposition).toBe("documented");
    expect(result.trigger.capture.evidenceEventId).toMatch(/^evt_/);
    expect(result.changelog.entryCount).toBeGreaterThanOrEqual(2);
    expect(result.package.releasePageId).toBeTruthy();
    expect(result.pdf.outputPath).toContain("release.pdf");
    expect(result.sync.outputPath).toContain("release.md");
    expect(result.helpCenter.articleCount).toBeGreaterThanOrEqual(1);
    expect(Array.from(notion._pages.values()).filter((page) => page.parent.database_id === "events_db")).toHaveLength(1);
  }, 20_000);

  it("reports runner release automation status and health summary", async () => {
    const { store } = await setupProject();
    await store.setLastSeenReleaseTag("project_1", "C:/repo", "v1.2.3");
    await store.setReleaseAutomationRun({
      projectId: "project_1",
      repoPath: "C:/repo",
      releaseTag: "v1.2.3",
      releaseVersion: "1.2.3",
      status: "success",
      attemptedAt: new Date().toISOString(),
    });
    await store.setReleaseAutomationRun({
      projectId: "project_1",
      repoPath: "C:/repo",
      releaseTag: "v1.2.4",
      releaseVersion: "1.2.4",
      status: "failure",
      attemptedAt: new Date().toISOString(),
      errorMessage: "PDF export failed",
    });

    const { registerGetRunnerReleaseAutomationStatusTool } = await import("../../src/tools/get-runner-release-automation-status.js");
    const { registerGetRunnerHealthSummaryTool } = await import("../../src/tools/get-runner-health-summary.js");
    const status = await handlerFor(registerGetRunnerReleaseAutomationStatusTool, "get_runner_release_automation_status");
    const health = await handlerFor(registerGetRunnerHealthSummaryTool, "get_runner_health_summary");

    const statusResult = parseTool<{ recentRunCount: number; lastSeenReleaseTag: string; lastFailedRun: { releaseTag: string } }>(
      await status({ projectId: "project_1", repoPath: "C:/repo", limit: 10 }),
    );
    expect(statusResult.recentRunCount).toBe(2);
    expect(statusResult.lastSeenReleaseTag).toBe("v1.2.3");
    expect(statusResult.lastFailedRun.releaseTag).toBe("v1.2.4");

    const healthResult = parseTool<{ targetCount: number; counts: { failing: number }; targets: Array<{ status: string }> }>(
      await health({ targets: [{ projectId: "project_1", repoPath: "C:/repo", releaseAutomation: true }] }),
    );
    expect(healthResult.targetCount).toBe(1);
    expect(healthResult.counts.failing).toBe(1);
    expect(healthResult.targets[0]?.status).toBe("failing");
  });
});
