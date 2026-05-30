import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeConfigForTool, writeWorkspaceConfigs, type ToolConfig } from "../../src/installer/universal-config-writer.js";

async function writeTempConfig(config: Omit<ToolConfig, "configPath"> & { fileName: string }, serverPath = "/tmp/mcp-server.js") {
  const dir = await mkdtemp(join(tmpdir(), "auto-doc-writer-paths-"));
  const configPath = join(dir, config.fileName);
  await writeConfigForTool({ ...config, configPath }, serverPath);
  return readFile(configPath, "utf8");
}

describe("universal config writer end-to-end paths", () => {
  it("writes OpenCode configs with nested mcp.servers shape", async () => {
    const raw = await writeTempConfig({
      tool: "OpenCode",
      pattern: "mcp-config",
      fileName: "opencode.json",
      format: "mcp",
      validator: "openCode",
    });

    expect(JSON.parse(raw) as unknown).toEqual({
      mcp: {
        servers: {
          "auto-doc-mcp": {
            command: "node",
            args: ["/tmp/mcp-server.js"],
            env: {
              NOTION_TOKEN: "__NOTION_TOKEN__",
            },
          },
        },
      },
    });
  });

  it("writes Zed configs with context_servers command blocks", async () => {
    const raw = await writeTempConfig({
      tool: "Zed",
      pattern: "plugin-config",
      fileName: "zed.json",
      format: "zed",
      validator: "zed",
    });

    expect(JSON.parse(raw) as unknown).toEqual({
      context_servers: {
        "auto-doc-mcp": {
          command: {
            path: "node",
            args: ["/tmp/mcp-server.js"],
            env: {
              NOTION_TOKEN: "__NOTION_TOKEN__",
            },
          },
          settings: {},
        },
      },
    });
  });

  it("writes Goose configs with a validated stdio extension block", async () => {
    const raw = await writeTempConfig({
      tool: "Goose",
      pattern: "mcp-config",
      fileName: "goose.yaml",
      format: "goose-yaml",
      validator: "goose",
    });

    expect(raw).toContain("extensions:");
    expect(raw).toContain("name: auto-doc-mcp");
    expect(raw).toContain("type: stdio");
    expect(raw).toContain("cmd: node");
    expect(raw).toContain("NOTION_TOKEN: \"__NOTION_TOKEN__\"");
  });

  it("writes experimental Amazon Q configs with the generic mcpServers envelope", async () => {
    const raw = await writeTempConfig({
      tool: "Amazon Q Developer",
      pattern: "mcp-config",
      fileName: "default.json",
      format: "mcpServers",
      validator: "amazonQ",
    });

    expect(JSON.parse(raw) as unknown).toEqual({
      mcpServers: {
        "auto-doc-mcp": {
          command: "node",
          args: ["/tmp/mcp-server.js"],
          env: {
            NOTION_TOKEN: "__NOTION_TOKEN__",
          },
        },
      },
    });
  });

  it("writes the documented VS Code and Continue workspace configs alongside the generic workspace file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-workspace-paths-"));
    await writeWorkspaceConfigs(dir, "/tmp/mcp-server.js");

    const rootRaw = await readFile(join(dir, ".mcp.json"), "utf8");
    expect(JSON.parse(rootRaw) as unknown).toEqual({
      mcpServers: {
        "auto-doc-mcp": {
          command: "node",
          args: ["/tmp/mcp-server.js"],
          env: {
            NOTION_TOKEN: "__NOTION_TOKEN__",
          },
        },
      },
    });

    const vscodeRaw = await readFile(join(dir, ".vscode", "mcp.json"), "utf8");
    expect(JSON.parse(vscodeRaw) as unknown).toEqual({
      servers: {
        "auto-doc-mcp": {
          type: "stdio",
          command: "node",
          args: ["/tmp/mcp-server.js"],
          env: {
            NOTION_TOKEN: "__NOTION_TOKEN__",
          },
        },
      },
    });

    const continueYaml = await readFile(join(dir, ".continue", "config.yaml"), "utf8");
    expect(continueYaml).toContain("mcpServers:");
    expect(continueYaml).toContain("name: auto-doc-mcp");
    expect(continueYaml).toContain("type: stdio");
    expect(continueYaml).toContain("command: node");
  });
});