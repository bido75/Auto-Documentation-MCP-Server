import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { simpleGit } from "simple-git";
import { StateStore } from "../../src/lib/state-store.js";
import { registerAnalyzeDocumentationCandidateTool } from "../../src/tools/analyze-documentation-candidate.js";
import { registerCaptureDevelopmentEventTool } from "../../src/tools/capture-development-event.js";
import { registerCaptureFeatureScreenshotTool } from "../../src/tools/capture-feature-screenshot.js";
import { registerExportHelpCenterContentTool } from "../../src/tools/export-help-center-content.js";
import { registerExportManualMarkdownTool } from "../../src/tools/export-manual-markdown.js";
import { registerExportManualPdfTool } from "../../src/tools/export-manual-pdf.js";
import { registerGenerateReleaseChangelogTool } from "../../src/tools/generate-release-changelog.js";
import { registerGetDocumentationStatusTool } from "../../src/tools/get-documentation-status.js";
import { registerGetGitDiffSummaryTool } from "../../src/tools/get-git-diff-summary.js";
import { registerGetRunnerFailureTriageMetadataTool } from "../../src/tools/get-runner-failure-triage-metadata.js";
import { registerGetRunnerHealthSummaryTool } from "../../src/tools/get-runner-health-summary.js";
import { registerGetRunnerReleaseAutomationStatusTool } from "../../src/tools/get-runner-release-automation-status.js";
import { registerInitializeProjectManualTool } from "../../src/tools/initialize-project-manual.js";
import { registerPackageManualTool } from "../../src/tools/package-manual.js";
import { registerPublishPrCommentTool } from "../../src/tools/publish-pr-comment.js";
import { registerPublishOrQueueReviewTool } from "../../src/tools/publish-or-queue-review.js";
import { registerRunReleaseDocumentationPipelineTool } from "../../src/tools/run-release-documentation-pipeline.js";
import { registerSetRunnerFailureTriageMetadataTool } from "../../src/tools/set-runner-failure-triage-metadata.js";
import { registerSyncManualToLocalDocsTool } from "../../src/tools/sync-manual-to-local-docs.js";
import { registerUpsertFeatureDocumentationTool } from "../../src/tools/upsert-feature-documentation.js";

const testContext = vi.hoisted(() => {
  return {
    notion: null as unknown,
    store: null as StateStore | null,
  };
});

vi.mock("../../src/lib/notion-client.js", () => ({
  createNotionClient: () => testContext.notion,
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

vi.mock("../../src/lib/screenshots.js", () => ({
  captureScreenshot: async (_url: string, outputPath: string) => outputPath,
}));

vi.mock("../../src/lib/pdf.js", () => ({
  generatePdfFromMarkdown: async (input: { outputPath: string }) => input.outputPath,
}));

type FakePage = {
  id: string;
  parent: { database_id: string };
  properties: Record<string, unknown>;
  children: unknown[];
};

function getTextValue(property: unknown): string {
  if (!property || typeof property !== "object") {
    return "";
  }

  const asRecord = property as Record<string, unknown>;

  if (Array.isArray(asRecord.rich_text)) {
    const first = asRecord.rich_text[0] as { text?: { content?: string } } | undefined;
    return first?.text?.content ?? "";
  }

  if (Array.isArray(asRecord.title)) {
    const first = asRecord.title[0] as { text?: { content?: string } } | undefined;
    return first?.text?.content ?? "";
  }

  return "";
}

function getStatusValue(property: unknown): string {
  if (!property || typeof property !== "object") {
    return "";
  }

  const asRecord = property as Record<string, unknown>;
  const status = asRecord.status as { name?: string } | undefined;
  return status?.name ?? "";
}

function getRelationIds(property: unknown): string[] {
  if (!property || typeof property !== "object") {
    return [];
  }

  const asRecord = property as Record<string, unknown>;
  const relation = asRecord.relation;
  if (!Array.isArray(relation)) {
    return [];
  }

  return relation
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const rel = item as { id?: string };
      return rel.id ?? "";
    })
    .filter((id) => id.length > 0);
}

function createFakeNotion(parentPageId = "parent_page") {
  let idCounter = 0;
  const databases = new Map<string, { id: string; title: string }>();
  const pages = new Map<string, FakePage>();

  const nextId = (prefix: string) => {
    idCounter += 1;
    return `${prefix}_${idCounter}`;
  };

  const matchesClause = (page: FakePage, clause: Record<string, unknown>) => {
    const propertyName = clause.property;
    if (typeof propertyName !== "string") {
      return false;
    }

    const candidate = page.properties[propertyName];

    if (typeof clause.relation === "object" && clause.relation !== null) {
      const relation = clause.relation as { contains?: string };
      if (relation.contains) {
        return getRelationIds(candidate).includes(relation.contains);
      }
    }

    if (typeof clause.rich_text === "object" && clause.rich_text !== null) {
      const richText = clause.rich_text as { equals?: string };
      if (richText.equals !== undefined) {
        return getTextValue(candidate) === richText.equals;
      }
    }

    if (typeof clause.title === "object" && clause.title !== null) {
      const title = clause.title as { equals?: string };
      if (title.equals !== undefined) {
        return getTextValue(candidate) === title.equals;
      }
    }

    if (typeof clause.status === "object" && clause.status !== null) {
      const status = clause.status as { equals?: string };
      if (status.equals !== undefined) {
        return getStatusValue(candidate) === status.equals;
      }
    }

    return false;
  };

  return {
    users: {
      me: vi.fn(async () => ({ object: "user" })),
    },
    blocks: {
      retrieve: vi.fn(async (input: { block_id: string }) => {
        if (input.block_id === parentPageId || pages.has(input.block_id)) {
          return { id: input.block_id };
        }

        throw { status: 404, message: "Not found" };
      }),
      children: {
        list: vi.fn(async (input: { block_id: string }) => {
          const page = pages.get(input.block_id);
          return {
            results: page?.children ?? [],
          };
        }),
      },
    },
    databases: {
      create: vi.fn(async (input: { title?: Array<{ text?: { content?: string } }> }) => {
        const id = nextId("db");
        const title = input.title?.[0]?.text?.content ?? "";
        databases.set(id, { id, title });
        return { id, url: `https://notion.local/${id}` };
      }),
      update: vi.fn(async () => ({})),
      retrieve: vi.fn(async (input: { database_id: string }) => {
        if (!databases.has(input.database_id)) {
          throw { status: 404, message: "Database not found" };
        }

        return { id: input.database_id };
      }),
      query: vi.fn(async (input: { database_id: string; filter?: Record<string, unknown>; page_size?: number }) => {
        const matches: FakePage[] = [];
        for (const page of pages.values()) {
          if (page.parent.database_id !== input.database_id) {
            continue;
          }

          if (!input.filter) {
            matches.push(page);
            continue;
          }

          if (Array.isArray(input.filter.and)) {
            const clauses = input.filter.and as Array<Record<string, unknown>>;
            if (clauses.every((clause) => matchesClause(page, clause))) {
              matches.push(page);
            }
            continue;
          }

          if (matchesClause(page, input.filter)) {
            matches.push(page);
          }
        }

        return {
          results: matches.slice(0, input.page_size ?? matches.length).map((page) => ({ id: page.id, properties: page.properties })),
        };
      }),
    },
    pages: {
      create: vi.fn(async (input: { parent: { database_id: string }; properties: Record<string, unknown>; children?: unknown[] }) => {
        const id = nextId("page");
        const page: FakePage = {
          id,
          parent: input.parent,
          properties: { ...input.properties },
          children: input.children ?? [],
        };
        pages.set(id, page);
        return { id, url: `https://notion.local/${id}` };
      }),
      update: vi.fn(async (input: { page_id: string; properties: Record<string, unknown> }) => {
        const page = pages.get(input.page_id);
        if (!page) {
          throw new Error(`Missing page ${input.page_id}`);
        }

        page.properties = {
          ...page.properties,
          ...input.properties,
        };

        return { id: page.id };
      }),
    },
  };
}

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>>();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) {
    this.handlers.set(name, handler);
  }
}

function parseToolResult<T>(value: { content: Array<{ type: string; text: string }> }): T {
  return JSON.parse(value.content[0].text) as T;
}

describe("tool success response contract", () => {
  it("returns stable success payloads with traceId and required keys across pipeline tools", async () => {
    const previousNotionToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = "test_token";

    try {
      const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-success-contract-"));
      testContext.store = new StateStore(join(stateDir, "state.json"));
      testContext.notion = createFakeNotion("parent_page");

      const server = new FakeServer();
      registerInitializeProjectManualTool(server as never);
      registerCaptureDevelopmentEventTool(server as never);
      registerAnalyzeDocumentationCandidateTool(server as never);
      registerUpsertFeatureDocumentationTool(server as never);
      registerPackageManualTool(server as never);
      registerGetDocumentationStatusTool(server as never);
      registerExportManualMarkdownTool(server as never);
      registerPublishOrQueueReviewTool(server as never);

      const initialize = server.handlers.get("initialize_project_manual");
      const capture = server.handlers.get("capture_development_event");
      const analyze = server.handlers.get("analyze_documentation_candidate");
      const upsert = server.handlers.get("upsert_feature_documentation");
      const pack = server.handlers.get("package_manual");
      const status = server.handlers.get("get_documentation_status");
      const exportMarkdown = server.handlers.get("export_manual_markdown");
      const publish = server.handlers.get("publish_or_queue_review");

      expect(initialize).toBeDefined();
      expect(capture).toBeDefined();
      expect(analyze).toBeDefined();
      expect(upsert).toBeDefined();
      expect(pack).toBeDefined();
      expect(status).toBeDefined();
      expect(exportMarkdown).toBeDefined();
      expect(publish).toBeDefined();

      const initialized = parseToolResult<{
        traceId: string;
        projectId: string;
        projectsDatabaseId: string;
        featuresDatabaseId: string;
        manualEntriesDatabaseId: string;
        evidenceEventsDatabaseId: string;
        releasesDatabaseId: string;
      }>(
        await initialize!({
          projectName: "Acme Success Contract",
          parentPageId: "parent_page",
          publishingMode: "balanced",
          autoPublishThreshold: 90,
        }),
      );

      expect(typeof initialized.traceId).toBe("string");
      expect(initialized.traceId.length).toBeGreaterThan(0);
      expect(typeof initialized.projectId).toBe("string");
      expect(typeof initialized.projectsDatabaseId).toBe("string");
      expect(typeof initialized.featuresDatabaseId).toBe("string");
      expect(typeof initialized.manualEntriesDatabaseId).toBe("string");
      expect(typeof initialized.evidenceEventsDatabaseId).toBe("string");
      expect(typeof initialized.releasesDatabaseId).toBe("string");

      const captured = parseToolResult<{
        traceId: string;
        evidenceEventId: string;
        evidencePageId: string;
        initialClassification: string;
      }>(
        await capture!({
          projectId: initialized.projectId,
          source: "local_git",
          eventType: "commit",
          summary: "Added billing settings page and export workflow",
          branch: "feature/billing-export",
          filesChanged: "src/routes/billing/settings.tsx",
          diffSummary: "Added user-facing billing workflow",
          testStatus: "passed",
        }),
      );

      expect(typeof captured.traceId).toBe("string");
      expect(typeof captured.evidenceEventId).toBe("string");
      expect(typeof captured.evidencePageId).toBe("string");
      expect(["true", "false", "uncertain"]).toContain(captured.initialClassification);

      const analyzed = parseToolResult<{
        traceId: string;
        shouldDocument: boolean;
        featureKey: string;
        featureName: string;
        confidenceScore: number;
        confidenceReasons: string[];
        reviewQuestions: string[];
      }>(
        await analyze!({
          projectId: initialized.projectId,
          evidenceEventIds: [captured.evidenceEventId],
        }),
      );

      expect(typeof analyzed.traceId).toBe("string");
      expect(typeof analyzed.shouldDocument).toBe("boolean");
      expect(typeof analyzed.featureKey).toBe("string");
      expect(typeof analyzed.featureName).toBe("string");
      expect(typeof analyzed.confidenceScore).toBe("number");
      expect(Array.isArray(analyzed.confidenceReasons)).toBe(true);
      expect(Array.isArray(analyzed.reviewQuestions)).toBe(true);

      const upserted = parseToolResult<{
        traceId: string;
        featureId: string;
        featureName: string;
        featureKey: string;
        evidenceEventIds: string[];
        publishing: { status: string; decision: string };
        manualEntries: Array<{ pageId: string; url?: string }>;
      }>(
        await upsert!({
          projectId: initialized.projectId,
          featureKey: analyzed.featureKey,
          featureName: analyzed.featureName,
          audiences: ["User", "Admin"],
          manualEntries: [
            {
              entryType: "User Guide",
              title: "Use Billing Export",
              userGuide: "Open Billing settings and click Export invoices.",
              adminGuide: "Configure billing permissions before export.",
              routes: ["/billing/settings"],
              apiEndpoints: ["/api/billing/export"],
            },
          ],
          evidenceEventIds: [captured.evidenceEventId],
          confidenceScore: 95,
          confidenceReasons: analyzed.confidenceReasons,
          publishingMode: "balanced",
          autoPublishThreshold: 90,
          sourceCommit: "abc123",
          filesChanged: ["src/routes/billing/settings.tsx"],
        }),
      );

      expect(typeof upserted.traceId).toBe("string");
      expect(typeof upserted.featureId).toBe("string");
      expect(typeof upserted.featureName).toBe("string");
      expect(typeof upserted.featureKey).toBe("string");
      expect(Array.isArray(upserted.evidenceEventIds)).toBe(true);
      expect(typeof upserted.publishing.status).toBe("string");
      expect(typeof upserted.publishing.decision).toBe("string");
      expect(Array.isArray(upserted.manualEntries)).toBe(true);
      expect(upserted.manualEntries.length).toBeGreaterThan(0);
      expect(typeof upserted.manualEntries[0].pageId).toBe("string");

      const manualEntryIds = upserted.manualEntries.map((entry) => entry.pageId);

      const published = parseToolResult<{
        traceId: string;
        featureId: string;
        manualEntryIds: string[];
        finalStatus: string;
        publishingDecision: string;
        reviewNotes: string;
      }>(
        await publish!({
          projectId: initialized.projectId,
          featureId: upserted.featureId,
          manualEntryIds,
          confidenceScore: 95,
          publishingMode: "balanced",
          autoPublishThreshold: 90,
        }),
      );

      expect(typeof published.traceId).toBe("string");
      expect(typeof published.featureId).toBe("string");
      expect(Array.isArray(published.manualEntryIds)).toBe(true);
      expect(typeof published.finalStatus).toBe("string");
      expect(typeof published.publishingDecision).toBe("string");
      expect(typeof published.reviewNotes).toBe("string");

      const packaged = parseToolResult<{
        traceId: string;
        format: string;
        projectId: string;
        releasePageId: string;
        includedEntryCount: number;
        excludedEntryCount: number;
        output: string;
      }>(
        await pack!({
          projectId: initialized.projectId,
          releaseVersion: "1.0.0",
          audience: "both",
          format: "markdown",
          manualEntryIds,
        }),
      );

      expect(typeof packaged.traceId).toBe("string");
      expect(packaged.format).toBe("markdown");
      expect(packaged.projectId).toBe(initialized.projectId);
      expect(typeof packaged.releasePageId).toBe("string");
      expect(typeof packaged.includedEntryCount).toBe("number");
      expect(typeof packaged.excludedEntryCount).toBe("number");
      expect(typeof packaged.output).toBe("string");
      expect(packaged.output).toContain("Manual");

      const currentStatus = parseToolResult<{
        traceId: string;
        projectId: string;
        releaseVersion: string | null;
        publishedCount: number;
        needsReviewCount: number;
        capturedCount: number;
        lowConfidenceCount: number;
        missingReviewQuestions: string[];
        health: string;
      }>(
        await status!({
          projectId: initialized.projectId,
          releaseVersion: "1.0.0",
        }),
      );

      expect(typeof currentStatus.traceId).toBe("string");
      expect(currentStatus.projectId).toBe(initialized.projectId);
      expect(typeof currentStatus.publishedCount).toBe("number");
      expect(typeof currentStatus.needsReviewCount).toBe("number");
      expect(typeof currentStatus.capturedCount).toBe("number");
      expect(typeof currentStatus.lowConfidenceCount).toBe("number");
      expect(Array.isArray(currentStatus.missingReviewQuestions)).toBe(true);
      expect(["Healthy", "Needs Review", "Behind"]).toContain(currentStatus.health);

      const exported = parseToolResult<{
        traceId: string;
        projectId: string;
        markdown: string;
      }>(
        await exportMarkdown!({
          projectId: initialized.projectId,
          audience: "both",
        }),
      );

      expect(typeof exported.traceId).toBe("string");
      expect(exported.projectId).toBe(initialized.projectId);
      expect(typeof exported.markdown).toBe("string");
      expect(exported.markdown).toContain("Manual");
    } finally {
      if (previousNotionToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = previousNotionToken;
      }
    }
  }, 30_000);

  it("returns stable success payloads for utility tools", async () => {
    const server = new FakeServer();
    registerGetGitDiffSummaryTool(server as never);
    registerCaptureFeatureScreenshotTool(server as never);

    const diff = server.handlers.get("get_git_diff_summary");
    const screenshot = server.handlers.get("capture_feature_screenshot");

    expect(diff).toBeDefined();
    expect(screenshot).toBeDefined();

    const repoDir = await mkdtemp(join(tmpdir(), "auto-doc-git-success-"));
    const git = simpleGit(repoDir);
    await git.init();
    await writeFile(join(repoDir, "README.md"), "hello\n", "utf-8");

    const summary = parseToolResult<{
      traceId: string;
      mode: string;
      summary: string;
    }>(
      await diff!({
        repoPath: repoDir,
        mode: "working_tree",
      }),
    );

    expect(typeof summary.traceId).toBe("string");
    expect(summary.mode).toBe("working_tree");
    expect(typeof summary.summary).toBe("string");

    const shot = parseToolResult<{
      traceId: string;
      ok: boolean;
      savedPath: string;
    }>(
      await screenshot!({
        url: "https://example.com",
        outputPath: "./tmp/success.png",
      }),
    );

    expect(typeof shot.traceId).toBe("string");
    expect(shot.ok).toBe(true);
    expect(shot.savedPath).toBe("./tmp/success.png");
  }, 15_000);

  it("returns stable success payloads for post-MVP tools", async () => {
    const previousNotionToken = process.env.NOTION_TOKEN;
    process.env.NOTION_TOKEN = "test_token";

    try {
      const stateDir = await mkdtemp(join(tmpdir(), "auto-doc-post-mvp-contract-"));
      testContext.store = new StateStore(join(stateDir, "state.json"));
      testContext.notion = createFakeNotion("parent_page");

      const server = new FakeServer();
      registerInitializeProjectManualTool(server as never);
      registerCaptureDevelopmentEventTool(server as never);
      registerAnalyzeDocumentationCandidateTool(server as never);
      registerUpsertFeatureDocumentationTool(server as never);
      registerGenerateReleaseChangelogTool(server as never);
      registerPublishPrCommentTool(server as never);
      registerExportManualPdfTool(server as never);
      registerSyncManualToLocalDocsTool(server as never);
      registerExportHelpCenterContentTool(server as never);
      registerGetRunnerFailureTriageMetadataTool(server as never);
      registerGetRunnerHealthSummaryTool(server as never);
      registerGetRunnerReleaseAutomationStatusTool(server as never);
      registerSetRunnerFailureTriageMetadataTool(server as never);

      const initialize = server.handlers.get("initialize_project_manual");
      const capture = server.handlers.get("capture_development_event");
      const analyze = server.handlers.get("analyze_documentation_candidate");
      const upsert = server.handlers.get("upsert_feature_documentation");
      const generateChangelog = server.handlers.get("generate_release_changelog");
      const publishPrComment = server.handlers.get("publish_pr_comment");
      const exportPdf = server.handlers.get("export_manual_pdf");
      const syncLocalDocs = server.handlers.get("sync_manual_to_local_docs");
      const exportHelpCenter = server.handlers.get("export_help_center_content");
      const getRunnerFailureTriageMetadata = server.handlers.get("get_runner_failure_triage_metadata");
      const getRunnerHealthSummary = server.handlers.get("get_runner_health_summary");
      const getRunnerStatus = server.handlers.get("get_runner_release_automation_status");
      const setRunnerFailureTriageMetadata = server.handlers.get("set_runner_failure_triage_metadata");

      expect(initialize).toBeDefined();
      expect(capture).toBeDefined();
      expect(analyze).toBeDefined();
      expect(upsert).toBeDefined();
      expect(generateChangelog).toBeDefined();
      expect(publishPrComment).toBeDefined();
      expect(exportPdf).toBeDefined();
      expect(syncLocalDocs).toBeDefined();
      expect(exportHelpCenter).toBeDefined();
      expect(getRunnerFailureTriageMetadata).toBeDefined();
      expect(getRunnerHealthSummary).toBeDefined();
      expect(getRunnerStatus).toBeDefined();
      expect(setRunnerFailureTriageMetadata).toBeDefined();

      const initialized = parseToolResult<{
        projectId: string;
      }>(
        await initialize!({
          projectName: "Acme Post-MVP Contract",
          parentPageId: "parent_page",
          publishingMode: "balanced",
          autoPublishThreshold: 90,
        }),
      );

      const captured = parseToolResult<{
        evidenceEventId: string;
      }>(
        await capture!({
          projectId: initialized.projectId,
          source: "github",
          eventType: "pr_merged",
          summary: "Merged billing export workflow",
          prUrl: "https://github.com/acme/app/pull/42",
          filesChanged: "src/routes/billing/settings.tsx",
          testStatus: "passed",
        }),
      );

      const analyzed = parseToolResult<{
        featureKey: string;
        featureName: string;
        confidenceReasons: string[];
      }>(
        await analyze!({
          projectId: initialized.projectId,
          evidenceEventIds: [captured.evidenceEventId],
        }),
      );

      await upsert!({
        projectId: initialized.projectId,
        featureKey: analyzed.featureKey,
        featureName: analyzed.featureName,
        audiences: ["User", "Admin"],
        manualEntries: [
          {
            entryType: "User Guide",
            title: "Export invoices from Billing",
            userGuide: "Open Billing and click Export.",
            adminGuide: "Ensure billing export permissions are enabled.",
          },
        ],
        evidenceEventIds: [captured.evidenceEventId],
        confidenceScore: 95,
        confidenceReasons: analyzed.confidenceReasons,
        publishingMode: "balanced",
        autoPublishThreshold: 90,
        sourcePr: "https://github.com/acme/app/pull/42",
      });

      const changelog = parseToolResult<{
        traceId: string;
        projectId: string;
        releaseVersion: string;
        releaseLinked: boolean;
        entryCount: number;
        sectionCounts: Record<string, number>;
        changelogMarkdown: string;
      }>(
        await generateChangelog!({
          projectId: initialized.projectId,
          releaseVersion: "2.0.0",
        }),
      );

      expect(typeof changelog.traceId).toBe("string");
      expect(changelog.projectId).toBe(initialized.projectId);
      expect(changelog.releaseVersion).toBe("2.0.0");
      expect(typeof changelog.releaseLinked).toBe("boolean");
      expect(typeof changelog.entryCount).toBe("number");
      expect(typeof changelog.sectionCounts).toBe("object");
      expect(typeof changelog.changelogMarkdown).toBe("string");

      const prComment = parseToolResult<{
        traceId: string;
        projectId: string;
        prUrl: string;
        dryRun: boolean;
        action: string;
        entryCount: number;
        commentBody: string;
      }>(
        await publishPrComment!({
          projectId: initialized.projectId,
          prUrl: "https://github.com/acme/app/pull/42",
          dryRun: true,
        }),
      );

      expect(typeof prComment.traceId).toBe("string");
      expect(prComment.projectId).toBe(initialized.projectId);
      expect(prComment.prUrl).toBe("https://github.com/acme/app/pull/42");
      expect(prComment.dryRun).toBe(true);
      expect(prComment.action).toBe("none");
      expect(typeof prComment.entryCount).toBe("number");
      expect(prComment.commentBody).toContain("auto-doc-pr-comment");

      const pdfResult = parseToolResult<{
        traceId: string;
        projectId: string;
        releaseVersion: string;
        audience: string;
        includedEntryCount: number;
        excludedEntryCount: number;
        outputPath: string;
      }>(
        await exportPdf!({
          projectId: initialized.projectId,
          releaseVersion: "2.0.0",
          audience: "both",
          outputPath: join(stateDir, "artifacts", "manual-2.0.0.pdf"),
        }),
      );

      expect(typeof pdfResult.traceId).toBe("string");
      expect(pdfResult.projectId).toBe(initialized.projectId);
      expect(pdfResult.releaseVersion).toBe("2.0.0");
      expect(pdfResult.audience).toBe("both");
      expect(typeof pdfResult.includedEntryCount).toBe("number");
      expect(typeof pdfResult.excludedEntryCount).toBe("number");
      expect(pdfResult.outputPath).toContain("manual-2.0.0.pdf");

      const syncResult = parseToolResult<{
        traceId: string;
        projectId: string;
        releaseVersion: string | null;
        audience: string;
        outputPath: string;
        entryCount: number;
        byteLength: number;
      }>(
        await syncLocalDocs!({
          projectId: initialized.projectId,
          audience: "both",
          outputPath: join(stateDir, "docs", "MANUAL.md"),
        }),
      );

      expect(typeof syncResult.traceId).toBe("string");
      expect(syncResult.projectId).toBe(initialized.projectId);
      expect(syncResult.releaseVersion).toBeNull();
      expect(syncResult.audience).toBe("both");
      expect(syncResult.outputPath).toContain("MANUAL.md");
      expect(typeof syncResult.entryCount).toBe("number");
      expect(typeof syncResult.byteLength).toBe("number");

      const helpCenter = parseToolResult<{
        traceId: string;
        version: string;
        projectId: string;
        releaseVersion: string | null;
        audience: string;
        sectionCount: number;
        articleCount: number;
        sections: Array<unknown>;
        outputPath: string | null;
      }>(
        await exportHelpCenter!({
          projectId: initialized.projectId,
          audience: "both",
          outputPath: join(stateDir, "docs", "help-center.json"),
        }),
      );

      expect(typeof helpCenter.traceId).toBe("string");
      expect(helpCenter.version).toBe("1");
      expect(helpCenter.projectId).toBe(initialized.projectId);
      expect(helpCenter.releaseVersion).toBeNull();
      expect(helpCenter.audience).toBe("both");
      expect(typeof helpCenter.sectionCount).toBe("number");
      expect(typeof helpCenter.articleCount).toBe("number");
      expect(Array.isArray(helpCenter.sections)).toBe(true);
      expect(helpCenter.outputPath).toContain("help-center.json");

      const runnerRepoPath = join(stateDir, "runner-repo");
      await testContext.store.setLastSeenReleaseTag(initialized.projectId, runnerRepoPath, "v2.0.0");
      await testContext.store.setReleaseAutomationRun({
        projectId: initialized.projectId,
        repoPath: runnerRepoPath,
        releaseTag: "v2.0.0",
        releaseVersion: "2.0.0",
        status: "success",
        attemptedAt: new Date().toISOString(),
      });

      const runnerStatus = parseToolResult<{
        traceId: string;
        projectId: string;
        repoPath: string;
        releaseTag: string | null;
        lastSeenReleaseTag: string | null;
        recentRunCount: number;
        queriedRun: Record<string, unknown> | null;
        lastSuccessfulRun: Record<string, unknown> | null;
        lastFailedRun: Record<string, unknown> | null;
        recentRuns: Array<Record<string, unknown>>;
      }>(
        await getRunnerStatus!({
          projectId: initialized.projectId,
          repoPath: runnerRepoPath,
          releaseTag: "v2.0.0",
          limit: 5,
        }),
      );

      expect(typeof runnerStatus.traceId).toBe("string");
      expect(runnerStatus.projectId).toBe(initialized.projectId);
      expect(runnerStatus.repoPath).toBe(runnerRepoPath);
      expect(runnerStatus.releaseTag).toBe("v2.0.0");
      expect(runnerStatus.lastSeenReleaseTag).toBe("v2.0.0");
      expect(typeof runnerStatus.recentRunCount).toBe("number");
      expect(typeof runnerStatus.queriedRun).toBe("object");
      expect(typeof runnerStatus.lastSuccessfulRun).toBe("object");
      expect(Array.isArray(runnerStatus.recentRuns)).toBe(true);

      const runnerTriageMetadata = parseToolResult<{
        traceId: string;
        projectId: string;
        repoPath: string;
        action: string;
        triageMetadata: {
          acknowledgedAt: string;
          acknowledgedBy: string;
          note: string;
          cooldownUntil: string;
        };
      }>(
        await setRunnerFailureTriageMetadata!({
          projectId: initialized.projectId,
          repoPath: runnerRepoPath,
          action: "set",
          acknowledge: true,
          acknowledgedAt: "2026-05-26T07:00:00.000Z",
          acknowledgedBy: "ops@example.com",
          note: "Known issue",
          cooldownUntil: "2026-05-26T08:00:00.000Z",
        }),
      );

      expect(typeof runnerTriageMetadata.traceId).toBe("string");
      expect(runnerTriageMetadata.projectId).toBe(initialized.projectId);
      expect(runnerTriageMetadata.repoPath).toBe(runnerRepoPath);
      expect(runnerTriageMetadata.action).toBe("set");
      expect(typeof runnerTriageMetadata.triageMetadata.acknowledgedAt).toBe("string");
      expect(typeof runnerTriageMetadata.triageMetadata.cooldownUntil).toBe("string");

      const runnerTriageMetadataStatus = parseToolResult<{
        traceId: string;
        projectId: string;
        repoPath: string;
        historyView: string;
        sortOrder: string;
        responseMode: string;
        timelineLabels: string[];
        triageMetadata: Record<string, unknown> | null;
        historyCount: number;
        totalHistoryCount: number;
        lastAcknowledgement: Record<string, unknown> | null;
        lastCooldownChange: Record<string, unknown> | null;
        recentHistory: Array<Record<string, unknown>>;
      }>(
        await getRunnerFailureTriageMetadata!({
          projectId: initialized.projectId,
          repoPath: runnerRepoPath,
          limit: 5,
        }),
      );

      expect(typeof runnerTriageMetadataStatus.traceId).toBe("string");
      expect(runnerTriageMetadataStatus.projectId).toBe(initialized.projectId);
      expect(runnerTriageMetadataStatus.repoPath).toBe(runnerRepoPath);
      expect(typeof runnerTriageMetadataStatus.historyView).toBe("string");
      expect(typeof runnerTriageMetadataStatus.sortOrder).toBe("string");
      expect(typeof runnerTriageMetadataStatus.responseMode).toBe("string");
      expect(Array.isArray(runnerTriageMetadataStatus.timelineLabels)).toBe(true);
      expect(typeof runnerTriageMetadataStatus.historyCount).toBe("number");
      expect(typeof runnerTriageMetadataStatus.totalHistoryCount).toBe("number");
      expect(Array.isArray(runnerTriageMetadataStatus.recentHistory)).toBe(true);
      expect(typeof runnerTriageMetadataStatus.lastAcknowledgement).toBe("object");
      expect(typeof runnerTriageMetadataStatus.lastCooldownChange).toBe("object");

      const runnerTriageTimeline = parseToolResult<{
        responseMode: string;
        timelineLabels: string[];
        timeline: {
          eventCount: number;
          labels: {
            acknowledged: number;
            cooldown_set: number;
            cleared: number;
          };
          events: Array<Record<string, unknown>>;
        };
      }>(
        await getRunnerFailureTriageMetadata!({
          projectId: initialized.projectId,
          repoPath: runnerRepoPath,
          responseMode: "timeline",
          timelineLabels: ["acknowledged"],
          limit: 5,
        }),
      );

      expect(runnerTriageTimeline.responseMode).toBe("timeline");
      expect(runnerTriageTimeline.timelineLabels).toEqual(["acknowledged"]);
      expect(typeof runnerTriageTimeline.timeline.eventCount).toBe("number");
      expect(typeof runnerTriageTimeline.timeline.labels).toBe("object");
      expect(Array.isArray(runnerTriageTimeline.timeline.events)).toBe(true);

      const runnerHealthSummary = parseToolResult<{
        traceId: string;
        source: string;
        targetCount: number;
        counts: {
          healthy: number;
          failing: number;
          pending: number;
          disabled: number;
          noData: number;
        };
        triage: {
          criticalCount: number;
          highCount: number;
          mediumCount: number;
          lowCount: number;
          staleFailureCount: number;
          escalationCount: number;
          acknowledgedCount: number;
          cooldownActiveCount: number;
          newestFailureAt: string | null;
          oldestFailureAt: string | null;
          highestPriorityCount: number;
          highestPriorityLimit: number;
          staleFailureMinutesThreshold: number;
          escalationFailureStreakThreshold: number;
        };
        failingTargets: Array<Record<string, unknown>>;
        highestPriorityTargets: Array<Record<string, unknown>>;
        targets: Array<Record<string, unknown>>;
      }>(
        await getRunnerHealthSummary!({
          targets: [
            {
              projectId: initialized.projectId,
              repoPath: runnerRepoPath,
              releaseAutomation: true,
            },
          ],
          limitPerTarget: 1,
        }),
      );

      expect(typeof runnerHealthSummary.traceId).toBe("string");
      expect(runnerHealthSummary.source).toBe("input");
      expect(typeof runnerHealthSummary.targetCount).toBe("number");
      expect(typeof runnerHealthSummary.counts).toBe("object");
      expect(typeof runnerHealthSummary.triage).toBe("object");
      expect(typeof runnerHealthSummary.triage.staleFailureCount).toBe("number");
      expect(typeof runnerHealthSummary.triage.escalationCount).toBe("number");
      expect(typeof runnerHealthSummary.triage.acknowledgedCount).toBe("number");
      expect(typeof runnerHealthSummary.triage.cooldownActiveCount).toBe("number");
      expect(Array.isArray(runnerHealthSummary.failingTargets)).toBe(true);
      expect(Array.isArray(runnerHealthSummary.highestPriorityTargets)).toBe(true);
      expect(Array.isArray(runnerHealthSummary.targets)).toBe(true);
      if (runnerHealthSummary.targets[0]) {
        expect(typeof runnerHealthSummary.targets[0].failureStreak).toBe("number");
        expect(typeof runnerHealthSummary.targets[0].lastSuccessAt).toBe("string");
      }
      if (runnerHealthSummary.failingTargets[0]) {
        expect(typeof runnerHealthSummary.failingTargets[0].stale).toBe("boolean");
        expect(typeof runnerHealthSummary.failingTargets[0].escalated).toBe("boolean");
        expect(typeof runnerHealthSummary.failingTargets[0].acknowledged).toBe("boolean");
        expect(typeof runnerHealthSummary.failingTargets[0].cooldownActive).toBe("boolean");
        expect(typeof runnerHealthSummary.failingTargets[0].priorityScore).toBe("number");
      }

      const pipelineServer = new FakeServer();
      registerRunReleaseDocumentationPipelineTool(pipelineServer as never);
      const runPipeline = pipelineServer.handlers.get("run_release_documentation_pipeline");
      expect(runPipeline).toBeDefined();

      const repoDir = await mkdtemp(join(tmpdir(), "auto-doc-post-mvp-pipeline-"));
      const git = simpleGit(repoDir);
      await git.init();
      await writeFile(join(repoDir, "README.md"), "pipeline test\n", "utf-8");

      const pipelineResult = parseToolResult<{
        traceId: string;
        projectId: string;
        releaseVersion: string;
        trigger: Record<string, unknown>;
        changelog: Record<string, unknown>;
        package: Record<string, unknown>;
        pdf: Record<string, unknown>;
        sync: Record<string, unknown>;
        helpCenter: Record<string, unknown> | null;
        prComment: null;
      }>(
        await runPipeline!({
          projectId: initialized.projectId,
          releaseVersion: "2.0.0",
          repoPath: repoDir,
          mode: "working_tree",
          audience: "both",
          packageFormat: "markdown",
          pdfOutputPath: join(stateDir, "artifacts", "pipeline-manual.pdf"),
          localDocsOutputPath: join(stateDir, "docs", "pipeline-MANUAL.md"),
          helpCenterOutputPath: join(stateDir, "docs", "pipeline-help-center.json"),
        }),
      );

      expect(typeof pipelineResult.traceId).toBe("string");
      expect(pipelineResult.projectId).toBe(initialized.projectId);
      expect(pipelineResult.releaseVersion).toBe("2.0.0");
      expect(typeof pipelineResult.trigger).toBe("object");
      expect(typeof pipelineResult.changelog).toBe("object");
      expect(typeof pipelineResult.package).toBe("object");
      expect(typeof pipelineResult.pdf).toBe("object");
      expect(typeof pipelineResult.sync).toBe("object");
      expect(typeof pipelineResult.helpCenter).toBe("object");
      expect(pipelineResult.prComment).toBeNull();
    } finally {
      if (previousNotionToken === undefined) {
        delete process.env.NOTION_TOKEN;
      } else {
        process.env.NOTION_TOKEN = previousNotionToken;
      }
    }
  }, 30_000);
});
