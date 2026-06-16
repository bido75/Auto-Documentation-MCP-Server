import { describe, expect, it, vi } from "vitest";
import type { ModelAnalysis } from "../../src/providers/base.js";

const provider = vi.hoisted(() => ({
  output: {} as unknown as ModelAnalysis,
}));

vi.mock("../../src/providers/factory.js", () => ({
  analyzeWithFallback: vi.fn(async () => provider.output),
  embedText: vi.fn(async () => []),
}));

describe("analyzer output repair", () => {
  it("repairs loose provider JSON with alternate guide keys without falling back to deterministic", async () => {
    provider.output = {
      featureName: "Manual Authoring",
      featureKey: "manual-authoring",
      shouldDocument: true,
      audiences: ["User", "Admin"],
      user: {
        overview: "Users can generate a complete manual from captured development evidence.",
        instructions: "Initialize the project manual.\nRun the autonomous documentation trigger.\nExport the assembled manual.",
        result: "A readable user manual is available in Notion.",
        errors: "Check the Notion token if pages cannot be created.",
      },
      admin: {
        requirements: "NOTION_TOKEN and STATE_ENCRYPTION_KEY must be configured.",
        endpoints: "GET /health",
        env: "NOTION_TOKEN, STATE_ENCRYPTION_KEY",
        verify: "Run npm run build before starting bridge mode.",
        troubleshooting: "Inspect provider fallback logs when authoring is thin.",
      },
      confidenceScore: 84,
      confidenceReasons: ["Provider produced recoverable loose JSON."],
      reviewQuestions: [],
      providerUsed: "cloud-openai:qwen/qwen3.6-flash",
      generationMs: 7,
    } as unknown as ModelAnalysis;

    const { analyzeDocumentationCandidate } = await import("../../src/lib/analyzer.js");
    const result = await analyzeDocumentationCandidate({
      projectId: "project_1",
      evidence: [
        {
          summary: "Added manual authoring workflow",
          diffSummary: "Manual authoring now produces User and Admin manuals.",
          filesChanged: ["src/lib/manual-author.ts"],
          eventType: "commit",
          source: "local_git",
          testStatus: "passed",
          branch: "feature/manual-authoring",
        },
      ],
      existingFeatureKeys: [],
    });

    expect(result.shouldDocument).toBe(true);
    expect(result.generatedNarratives.providerUsed).toBe("cloud-openai:qwen/qwen3.6-flash");
    expect(result.generatedNarratives.userGuide.summary).toContain("complete manual");
    expect(result.generatedNarratives.userGuide.steps).toContain("Initialize the project manual.");
    expect(result.generatedNarratives.adminGuide.envVarsRequired).toEqual(["NOTION_TOKEN", "STATE_ENCRYPTION_KEY"]);
    expect(result.confidenceReasons.join(" ")).toContain("Provider output repaired");
    expect(result.confidenceReasons.join(" ")).toContain("Provider used: cloud-openai:qwen/qwen3.6-flash");
  });

  it("repairs provider JSON that uses overview, workflow_pipeline, and configuration sections", async () => {
    provider.output = {
      overview:
        "Implements a complete Model Context Protocol tool pipeline for automated Notion documentation from development evidence.",
      changed_files: [
        { path: "README.md", type: "documentation", description: "Documents the MCP tool workflow." },
        { path: "src/index.ts", type: "source", description: "Registers server tools." },
      ],
      workflow_pipeline: [
        {
          step: 1,
          name: "Initialize",
          tool: "initialize-manual-project",
          description: "Set up the Notion manual project structure.",
        },
        {
          step: 2,
          name: "Capture",
          tool: "capture-development-event",
          description: "Record development evidence for documentation analysis.",
        },
      ],
      configuration: {
        environment_variables: ["NOTION_TOKEN", "STATE_ENCRYPTION_KEY"],
        api_endpoints: [],
      },
      testing: { status: "passed" },
      providerUsed: "cloud-openai:qwen/qwen3.6-flash",
      generationMs: 12,
    } as unknown as ModelAnalysis;

    const { analyzeDocumentationCandidate } = await import("../../src/lib/analyzer.js");
    const result = await analyzeDocumentationCandidate({
      projectId: "project_1",
      evidence: [
        {
          summary: "Core MCP tool pipeline workflow for initializing a Notion manual",
          diffSummary: "README and server registration describe the initialize -> capture -> analyze -> upsert workflow.",
          filesChanged: ["README.md", "src/index.ts"],
          eventType: "commit",
          source: "local_git",
          testStatus: "passed",
          branch: "main",
        },
      ],
      existingFeatureKeys: [],
    });

    expect(result.shouldDocument).toBe(true);
    expect(result.generatedNarratives.providerUsed).toBe("cloud-openai:qwen/qwen3.6-flash");
    expect(result.generatedNarratives.userGuide.summary).toContain("automated Notion documentation");
    expect(result.generatedNarratives.userGuide.steps).toContain("Set up the Notion manual project structure.");
    expect(result.generatedNarratives.adminGuide.envVarsRequired).toEqual(["NOTION_TOKEN", "STATE_ENCRYPTION_KEY"]);
    expect(result.audiences).toContain("Admin");
  });

  it("repairs provider JSON with workflow_architecture and pipeline_steps", async () => {
    provider.output = {
      change_metadata: {
        commit_summary: "Autonomous documentation trigger workflow captures local git evidence.",
        test_status: "passed",
      },
      workflow_architecture: {
        overview: "The orchestrator composes capture, analyze, upsert, and publish tools over real git evidence.",
        pipeline_steps: [
          "Capture local git evidence",
          "Analyze documentation candidates",
          "Upsert user and admin manual entries",
          "Publish or queue results",
        ],
      },
      scope_and_dependencies: {
        environment_variables: [],
      },
      providerUsed: "cloud-openai:qwen/qwen3.6-flash",
    } as unknown as ModelAnalysis;

    const { analyzeDocumentationCandidate } = await import("../../src/lib/analyzer.js");
    const result = await analyzeDocumentationCandidate({
      projectId: "project_1",
      evidence: [
        {
          summary: "Autonomous documentation trigger workflow captures local git evidence",
          diffSummary: "The orchestrator composes the registered capture, analyze, upsert, and publish tools.",
          filesChanged: ["src/orchestrator/auto-doc-orchestrator.ts"],
          eventType: "commit",
          source: "local_git",
          testStatus: "passed",
          branch: "main",
        },
      ],
      existingFeatureKeys: [],
    });

    expect(result.generatedNarratives.providerUsed).toBe("cloud-openai:qwen/qwen3.6-flash");
    expect(result.generatedNarratives.userGuide.summary).toContain("capture, analyze, upsert");
    expect(result.generatedNarratives.userGuide.steps).toContain("Capture local git evidence");
  });

  it("repairs provider JSON with technical_analysis or implementationDetails when no guide object exists", async () => {
    provider.output = {
      change_summary: "Release tools query Notion manual entries and produce packaged release output.",
      technical_analysis: {
        objective: "Automate packaging and publication of approved manual entries into release pages.",
        affected_modules: ["Documentation Pipeline", "Changelog Generator", "Manual Package Tool"],
        risk_assessment: "Low risk internal tooling change.",
      },
      integration_points: {
        environment_variables: [],
      },
      providerUsed: "cloud-openai:qwen/qwen3.6-flash",
    } as unknown as ModelAnalysis;

    const { analyzeDocumentationCandidate } = await import("../../src/lib/analyzer.js");
    const result = await analyzeDocumentationCandidate({
      projectId: "project_1",
      evidence: [
        {
          summary: "Release documentation pipeline workflow packages approved manual entries",
          diffSummary: "Release tools query Notion manual entries and releases.",
          filesChanged: ["src/tools/package-manual.ts"],
          eventType: "commit",
          source: "local_git",
          testStatus: "passed",
          branch: "main",
        },
      ],
      existingFeatureKeys: [],
    });

    expect(result.generatedNarratives.providerUsed).toBe("cloud-openai:qwen/qwen3.6-flash");
    expect(result.generatedNarratives.userGuide.summary).toContain("packaged release output");
    expect(result.generatedNarratives.userGuide.steps).toContain("Documentation Pipeline");
  });
});
