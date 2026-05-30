import { describe, expect, it, vi } from "vitest";

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

vi.mock("../../src/tools/run-autonomous-documentation-trigger.js", () => ({
  registerRunAutonomousDocumentationTriggerTool: (server: {
    tool: (name: string, description: string, schema: unknown, handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>) => void;
  }) => {
    server.tool("run_autonomous_documentation_trigger", "", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ status: "documented", eventId: "evt_release" }) }],
    }));
  },
}));

vi.mock("../../src/tools/generate-release-changelog.js", () => ({
  registerGenerateReleaseChangelogTool: (server: {
    tool: (name: string, description: string, schema: unknown, handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>) => void;
  }) => {
    server.tool("generate_release_changelog", "", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ entryCount: 4, changelogMarkdown: "# Changelog" }) }],
    }));
  },
}));

vi.mock("../../src/tools/package-manual.js", () => ({
  registerPackageManualTool: (server: {
    tool: (name: string, description: string, schema: unknown, handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>) => void;
  }) => {
    server.tool("package_manual", "", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ output: "https://notion.so/manual", includedEntryCount: 4 }) }],
    }));
  },
}));

vi.mock("../../src/tools/export-manual-pdf.js", () => ({
  registerExportManualPdfTool: (server: {
    tool: (name: string, description: string, schema: unknown, handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>) => void;
  }) => {
    server.tool("export_manual_pdf", "", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ outputPath: "artifacts/manual-2.0.0.pdf" }) }],
    }));
  },
}));

vi.mock("../../src/tools/sync-manual-to-local-docs.js", () => ({
  registerSyncManualToLocalDocsTool: (server: {
    tool: (name: string, description: string, schema: unknown, handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>) => void;
  }) => {
    server.tool("sync_manual_to_local_docs", "", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ outputPath: "docs/MANUAL.md", entryCount: 4 }) }],
    }));
  },
}));

vi.mock("../../src/tools/export-help-center-content.js", () => ({
  registerExportHelpCenterContentTool: (server: {
    tool: (name: string, description: string, schema: unknown, handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>) => void;
  }) => {
    server.tool("export_help_center_content", "", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ outputPath: "docs/help-center.json", sectionCount: 3, articleCount: 9 }) }],
    }));
  },
}));

vi.mock("../../src/tools/publish-pr-comment.js", () => ({
  registerPublishPrCommentTool: (server: {
    tool: (name: string, description: string, schema: unknown, handler: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>) => void;
  }) => {
    server.tool("publish_pr_comment", "", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ action: "updated", commentId: 1234 }) }],
    }));
  },
}));

describe("run_release_documentation_pipeline", () => {
  it("orchestrates release automation steps and returns aggregate outputs", async () => {
    const server = new FakeServer();
    const { registerRunReleaseDocumentationPipelineTool } = await import(
      "../../src/tools/run-release-documentation-pipeline.js"
    );
    registerRunReleaseDocumentationPipelineTool(server as never);

    const run = server.handlers.get("run_release_documentation_pipeline");
    expect(run).toBeDefined();

    const result = parseToolResult<{
      projectId: string;
      releaseVersion: string;
      trigger: { status: string; eventId: string };
      changelog: { entryCount: number };
      package: { includedEntryCount: number };
      pdf: { outputPath: string };
      sync: { outputPath: string; entryCount: number };
      helpCenter: { outputPath: string; sectionCount: number; articleCount: number } | null;
      prComment: { action: string; commentId: number } | null;
    }>(
      await run!({
        projectId: "proj_1",
        releaseVersion: "2.0.0",
        mode: "last_commit",
        helpCenterOutputPath: "docs/help-center.json",
        prUrl: "https://github.com/acme/app/pull/42",
      }),
    );

    expect(result.projectId).toBe("proj_1");
    expect(result.releaseVersion).toBe("2.0.0");
    expect(result.trigger.status).toBe("documented");
    expect(result.changelog.entryCount).toBe(4);
    expect(result.package.includedEntryCount).toBe(4);
    expect(result.pdf.outputPath).toContain("manual-2.0.0.pdf");
    expect(result.sync.outputPath).toBe("docs/MANUAL.md");
    expect(result.helpCenter?.outputPath).toBe("docs/help-center.json");
    expect(result.helpCenter?.sectionCount).toBe(3);
    expect(result.prComment?.action).toBe("updated");
    expect(result.prComment?.commentId).toBe(1234);
  });
});
