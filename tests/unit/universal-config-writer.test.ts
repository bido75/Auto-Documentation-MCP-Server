import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { TOOL_CONFIGS, validateMcpServersConfig, writeWorkspaceConfigs } from "../../src/installer/universal-config-writer";

describe("universal config writer", () => {
  it("includes the expanded ecosystem targets", () => {
    const toolNames = TOOL_CONFIGS.map((config) => config.tool);

    expect(toolNames).toEqual(
      expect.arrayContaining([
        "Amazon Q Developer",
      ]),
    );
  });

  it("graduates Amazon Q from experimental using the documented default.json path", () => {
    const amazonQ = TOOL_CONFIGS.find((config) => config.tool === "Amazon Q Developer");

    expect(amazonQ).toEqual(
      expect.objectContaining({
        configPath: expect.stringContaining(`${join(".aws", "amazonq", "default.json")}`),
        format: "mcpServers",
        validator: "amazonQ",
      }),
    );
    expect(amazonQ?.experimental).toBeUndefined();
  });

  it("does not keep unsupported vendor-specific raw config targets in the active writer list", () => {
    const toolNames = TOOL_CONFIGS.map((config) => config.tool);

    expect(toolNames).not.toEqual(
      expect.arrayContaining(["Sourcegraph Cody", "Pieces for Developers", "Sublime Text", "Nova"]),
    );
  });

  it("routes non-generic editor targets through dedicated validators", () => {
    const validatorByTool = new Map(
      TOOL_CONFIGS.filter((config) => ["OpenCode", "Goose", "Zed"].includes(config.tool)).map((config) => [config.tool, config.validator]),
    );

    expect(validatorByTool.get("OpenCode")).toBe("openCode");
    expect(validatorByTool.get("Goose")).toBe("goose");
    expect(validatorByTool.get("Zed")).toBe("zed");
  });

  it("does not keep the speculative global Continue.dev config.json target in the active writer list", () => {
    expect(TOOL_CONFIGS.some((config) => config.tool === "Continue.dev")).toBe(false);
  });

  it("does not expose a Copilot validator target before a writer path exists", () => {
    expect(TOOL_CONFIGS.some((config) => config.validator === "vscodeCopilot")).toBe(false);
  });

  it("validates mcpServers-shaped configs before writing", () => {
    expect(() =>
      validateMcpServersConfig({
        mcpServers: {
          "auto-doc-mcp": {
            command: "node",
            args: ["/tmp/mcp-server.js"],
            env: { NOTION_TOKEN: "__NOTION_TOKEN__" },
          },
        },
      }),
    ).not.toThrow();

    expect(() =>
      validateMcpServersConfig({
        mcpServers: {
          "auto-doc-mcp": {
            args: ["/tmp/mcp-server.js"],
          },
        },
      }),
    ).toThrow();
  });

  it("writes workspace mcp config with token placeholder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-workspace-config-"));
    await writeWorkspaceConfigs(dir, "/tmp/mcp-server.js");

    const jsonText = await readFile(join(dir, ".mcp.json"), "utf8");
    const parsed = JSON.parse(jsonText) as {
      mcpServers: {
        "auto-doc-mcp": {
          command: string;
          args: string[];
          env: { NOTION_TOKEN: string };
        };
      };
    };

    expect(parsed.mcpServers["auto-doc-mcp"]).toEqual({
      command: "node",
      args: ["/tmp/mcp-server.js"],
      env: {
        NOTION_TOKEN: "__NOTION_TOKEN__",
      },
    });
  });

  it("writes a vscode workspace mcp config alongside the root workspace file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-workspace-vscode-config-"));
    await writeWorkspaceConfigs(dir, "/tmp/mcp-server.js");

    const jsonText = await readFile(join(dir, ".vscode", "mcp.json"), "utf8");
    const parsed = JSON.parse(jsonText) as {
      servers: {
        "auto-doc-mcp": {
          type: string;
          command: string;
          args: string[];
          env: { NOTION_TOKEN: string };
        };
      };
    };

    expect(parsed.servers["auto-doc-mcp"]).toEqual({
      type: "stdio",
      command: "node",
      args: ["/tmp/mcp-server.js"],
      env: {
        NOTION_TOKEN: "__NOTION_TOKEN__",
      },
    });
  });

  it("writes a Continue.dev workspace config using the documented YAML mcpServers shape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-workspace-continue-config-"));
    await writeWorkspaceConfigs(dir, "/tmp/mcp-server.js");

    const yamlText = await readFile(join(dir, ".continue", "config.yaml"), "utf8");

    expect(yamlText).toContain("mcpServers:");
    expect(yamlText).toContain("name: auto-doc-mcp");
    expect(yamlText).toContain("type: stdio");
    expect(yamlText).toContain("command: node");
    expect(yamlText).toContain("- /tmp/mcp-server.js");
    expect(yamlText).toContain("NOTION_TOKEN: __NOTION_TOKEN__");
  });

  it("merges Continue workspace config non-destructively and preserves existing models, rules, and servers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "auto-doc-workspace-continue-merge-"));
    const continueDir = join(dir, ".continue");
    const continueConfigPath = join(continueDir, "config.yaml");

    await mkdir(continueDir, { recursive: true });
    await writeFile(
      continueConfigPath,
      [
        "# Existing Continue project config",
        "models:",
        "  - name: Existing Model",
        "    provider: openai",
        "# Keep this rule comment",
        "rules:",
        "  - keep existing rule",
        "mcpServers:",
        "  - name: existing-server",
        "    type: sse",
        "    url: https://example.com/sse",
        "  - name: auto-doc-mcp",
        "    type: stdio",
        "    command: node",
        "    args:",
        "      - /old/path.js",
        "    env:",
        "      EXISTING_KEY: keep-me",
        "",
      ].join("\n"),
      "utf8",
    );

    await writeWorkspaceConfigs(dir, "/tmp/mcp-server.js");

    const parsed = YAML.parse(await readFile(continueConfigPath, "utf8")) as {
      models?: Array<{ name?: string; provider?: string }>;
      rules?: string[];
      mcpServers?: Array<Record<string, unknown>>;
    };
    const mergedYamlText = await readFile(continueConfigPath, "utf8");

    expect(mergedYamlText).toContain("# Existing Continue project config");
    expect(mergedYamlText).toContain("# Keep this rule comment");

    expect(parsed.models).toEqual([
      {
        name: "Existing Model",
        provider: "openai",
      },
    ]);
    expect(parsed.rules).toEqual(["keep existing rule"]);

    const servers = parsed.mcpServers ?? [];
    expect(servers.some((server) => server.name === "existing-server")).toBe(true);

    const autoDocServers = servers.filter((server) => server.name === "auto-doc-mcp");
    expect(autoDocServers).toHaveLength(1);
    expect(autoDocServers[0]).toMatchObject({
      type: "stdio",
      command: "node",
      args: ["/tmp/mcp-server.js"],
      env: {
        EXISTING_KEY: "keep-me",
        NOTION_TOKEN: "__NOTION_TOKEN__",
      },
    });
  });
});
