import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMcpTargets, writeMcpConfig } from "../../packages/vscode-extension/src/mcp/config-writer";

describe("extension config writer", () => {
  it("adds or updates auto-doc server and preserves unrelated config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "auto-doc-extension-config-"));
    const configPath = join(tempDir, "mcp.json");

    await writeFile(
      configPath,
      JSON.stringify(
        {
          foo: "bar",
          mcpServers: {
            existing: {
              command: "node",
              args: ["existing.js"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await writeMcpConfig(configPath, "/tmp/mcp-server.js", "secret_test");

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      foo: string;
      mcpServers: Record<string, unknown>;
    };

    expect(parsed.foo).toBe("bar");
    expect(parsed.mcpServers.existing).toBeDefined();
    expect(parsed.mcpServers["auto-doc-mcp"]).toEqual({
      command: "node",
      args: ["/tmp/mcp-server.js"],
      env: {
        NOTION_TOKEN: "__NOTION_TOKEN__",
      },
    });
  });

  it("resolves cursor, windsurf, and workspace targets", () => {
    const targets = resolveMcpTargets("/workspace/demo");
    expect(targets.some((target) => target.name === "cursor")).toBe(true);
    expect(targets.some((target) => target.name === "windsurf")).toBe(true);
    expect(targets.some((target) => target.name === "workspace" && target.filePath.endsWith(".mcp.json"))).toBe(true);
  });
});
