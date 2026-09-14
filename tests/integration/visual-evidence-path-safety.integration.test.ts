/**
 * Acceptance: Visual feature criterion 1 - path safety (EXTENDS artifact-path-safety, does not fork)
 * Reuses the configured artifact-root helper from constrain-artifact-output-paths.
 * UNMOCKED: real temp artifact root. Must FAIL if path validation removed. DO NOT DELETE/SKIP.
 */
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";

type ToolResult = { content: Array<{ type: string; text: string }> };
type ToolHandler = (input: unknown) => Promise<ToolResult>;

class FakeServer {
  readonly handlers = new Map<string, ToolHandler>();

  tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
  }
}

async function handlerFor(register: (server: McpServer) => void, name: string): Promise<ToolHandler> {
  const server = new FakeServer();
  register(server as unknown as McpServer);
  const handler = server.handlers.get(name);
  expect(handler).toBeDefined();
  return handler!;
}

function parseError(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  return JSON.parse((error as Error).message) as { error: { code: string } };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

beforeEach(() => {
  delete process.env.AUTO_DOC_ARTIFACT_ROOT;
  delete process.env.AUTO_DOC_STATE_FILE;
});

describe("visual-evidence-path-safety", () => {
  it("attaching a figure with ../ traversal path returns typed error and writes nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-doc-visual-"));
    process.env.AUTO_DOC_ARTIFACT_ROOT = join(root, "artifacts");
    const outside = resolve(root, "escape.png");
    const { registerAttachVisualEvidenceTool } = await import("../../src/tools/attach-visual-evidence.js");
    const attach = await handlerFor(registerAttachVisualEvidenceTool, "attach_visual_evidence");

    await expect(
      attach({
        projectId: "project_1",
        caption: "Settings screen",
        imageBase64: Buffer.from("fake-png").toString("base64"),
        outputPath: "../escape.png",
      }),
    ).rejects.toSatisfy((error) => {
      expect(parseError(error).error.code).toBe("ARTIFACT_PATH_OUTSIDE_ROOT");
      return true;
    });
    expect(await exists(outside)).toBe(false);
  });

  it("attaching a figure with absolute-escape path returns typed error and writes nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-doc-visual-"));
    process.env.AUTO_DOC_ARTIFACT_ROOT = join(root, "artifacts");
    const outside = resolve(root, "escape.png");
    const { registerAttachVisualEvidenceTool } = await import("../../src/tools/attach-visual-evidence.js");
    const attach = await handlerFor(registerAttachVisualEvidenceTool, "attach_visual_evidence");

    await expect(
      attach({
        projectId: "project_1",
        caption: "Settings screen",
        imageBase64: Buffer.from("fake-png").toString("base64"),
        outputPath: outside,
      }),
    ).rejects.toSatisfy((error) => {
      expect(parseError(error).error.code).toBe("ARTIFACT_PATH_OUTSIDE_ROOT");
      return true;
    });
    expect(await exists(outside)).toBe(false);
  });

  it("attaching a figure under the artifact root writes a real file readable from disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-doc-visual-"));
    process.env.AUTO_DOC_ARTIFACT_ROOT = join(root, "artifacts");
    const { registerAttachVisualEvidenceTool } = await import("../../src/tools/attach-visual-evidence.js");
    const attach = await handlerFor(registerAttachVisualEvidenceTool, "attach_visual_evidence");

    const result = JSON.parse(
      (
        await attach({
          projectId: "project_1",
          caption: "Settings screen",
          imageBase64: Buffer.from("fake-png").toString("base64"),
          outputPath: "visuals/settings.png",
        })
      ).content[0].text,
    ) as { artifactPath: string };

    expect(result.artifactPath.startsWith(process.env.AUTO_DOC_ARTIFACT_ROOT)).toBe(true);
    expect(await readFile(result.artifactPath, "utf8")).toBe("fake-png");
  });

  it("figure reads/writes go through the SHARED artifact-root helper (not a second path check)", async () => {
    const { readFile: readSource } = await import("node:fs/promises");
    expect(await readSource("src/lib/visual-evidence.ts", "utf8")).toContain("resolveArtifactPath");
    expect(await readSource("src/tools/attach-visual-evidence.ts", "utf8")).toContain("attachVisualEvidence");
  });
});
