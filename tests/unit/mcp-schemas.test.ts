import { describe, expect, it } from "vitest";
import { AmazonQMcpConfigSchema } from "../../src/schemas/amazonQ";
import { AntigravityMcpConfigSchema } from "../../src/schemas/antigravity";
import { ContinueYamlConfigSchema } from "../../src/schemas/continueYaml";
import { ClaudeCodeMcpConfigSchema } from "../../src/schemas/claudeCode";
import { GenericMcpConfigSchema, McpServerEntrySchema, McpServersSchema } from "../../src/schemas/core";
import { GooseConfigSchema } from "../../src/schemas/goose";
import { KlineCodeMcpConfigSchema } from "../../src/schemas/klineCode";
import { OpenCodeMcpConfigSchema } from "../../src/schemas/openCode";
import { VsCodeSettingsSchema } from "../../src/schemas/vscodeCopilot";
import { VsCodeMcpConfigSchema } from "../../src/schemas/vscodeMcp";
import { ZedSettingsSchema } from "../../src/schemas/zed";
import { validators } from "../../src/validation";

describe("shared MCP schemas", () => {
  it("accepts a valid MCP server entry and keeps unknown metadata", () => {
    const parsed = McpServerEntrySchema.parse({
      command: "node",
      args: ["./dist/index.js"],
      env: { NOTION_TOKEN: "secret" },
      extraMetadata: true,
    });

    expect(parsed).toMatchInlineSnapshot(`
      {
        "args": [
          "./dist/index.js",
        ],
        "command": "node",
        "env": {
          "NOTION_TOKEN": "secret",
        },
        "extraMetadata": true,
      }
    `);
  });

  it("rejects a malformed MCP server entry", () => {
    expect(() =>
      McpServerEntrySchema.parse({
        command: 123,
      }),
    ).toThrow();
  });

  it("accepts a generic MCP config", () => {
    const parsed = GenericMcpConfigSchema.parse({
      mcpServers: {
        "auto-doc-mcp": {
          command: "node",
          args: ["./build/index.js"],
        },
      },
      vendorExtension: "allowed",
    });

    expect(parsed).toMatchInlineSnapshot(`
      {
        "mcpServers": {
          "auto-doc-mcp": {
            "args": [
              "./build/index.js",
            ],
            "command": "node",
          },
        },
        "vendorExtension": "allowed",
      }
    `);
  });

  it("rejects invalid MCP server maps", () => {
    expect(() =>
      McpServersSchema.parse({
        "auto-doc-mcp": { args: ["./build/index.js"] },
      }),
    ).toThrow();
  });
});

describe("per-agent MCP schemas", () => {
  const representativeSchemas = [
    {
      name: "VS Code Copilot",
      schema: VsCodeSettingsSchema,
      valid: {
        "github.copilot.mcpServers": {
          "auto-doc-mcp": {
            command: "node",
            args: ["./build/index.js"],
          },
        },
        otherSetting: true,
      },
      invalid: {
        "github.copilot.mcpServers": "not-an-object",
      },
    },
    {
      name: "Claude Code",
      schema: ClaudeCodeMcpConfigSchema,
      valid: {
        mcpServers: {
          "auto-doc-mcp": {
            command: "node",
          },
        },
      },
      invalid: {
        mcpServers: [],
      },
    },
    {
      name: "Amazon Q",
      schema: AmazonQMcpConfigSchema,
      valid: {
        mcpServers: {
          "auto-doc-mcp": {
            command: "node",
          },
        },
        version: "1.0.0",
      },
      invalid: {
        mcpServers: {
          "auto-doc-mcp": {
            command: 42,
          },
        },
      },
    },
    {
      name: "OpenCode",
      schema: OpenCodeMcpConfigSchema,
      valid: {
        mcp: {
          servers: {
            "auto-doc-mcp": {
              command: "node",
            },
          },
        },
      },
      invalid: {
        mcp: {
          servers: {
            "auto-doc-mcp": {
              args: ["./build/index.js"],
            },
          },
        },
      },
    },
    {
      name: "Kline Code",
      schema: KlineCodeMcpConfigSchema,
      valid: {
        mcpServers: {
          "auto-doc-mcp": {
            command: "node",
          },
        },
      },
      invalid: {
        mcpServers: {
          "auto-doc-mcp": {
            args: ["./build/index.js"],
          },
        },
      },
    },
    {
      name: "Continue YAML",
      schema: ContinueYamlConfigSchema,
      valid: {
        mcpServers: [
          {
            name: "auto-doc-mcp",
            type: "stdio",
            command: "node",
            args: ["./build/index.js"],
          },
        ],
      },
      invalid: {
        mcpServers: [
          {
            type: "stdio",
            args: ["./build/index.js"],
          },
        ],
      },
    },
    {
      name: "Zed",
      schema: ZedSettingsSchema,
      valid: {
        context_servers: {
          "auto-doc-mcp": {
            command: {
              path: "node",
              args: ["./build/index.js"],
              env: {
                NOTION_TOKEN: "secret",
              },
            },
            settings: {},
          },
        },
      },
      invalid: {
        context_servers: {
          "auto-doc-mcp": {
            command: {
              path: "node",
              args: ["./build/index.js"],
            },
          },
        },
      },
    },
    {
      name: "VS Code MCP",
      schema: VsCodeMcpConfigSchema,
      valid: {
        servers: {
          "auto-doc-mcp": {
            type: "stdio",
            command: "node",
            args: ["./build/index.js"],
          },
        },
      },
      invalid: {
        servers: {
          "auto-doc-mcp": {
            type: "stdio",
            args: ["./build/index.js"],
          },
        },
      },
    },
    {
      name: "Goose",
      schema: GooseConfigSchema,
      valid: {
        extensions: [
          {
            name: "auto-doc-mcp",
            type: "stdio",
            cmd: "node",
            args: ["./build/index.js"],
            enabled: true,
          },
        ],
      },
      invalid: {
        extensions: [
          {
            name: "auto-doc-mcp",
            type: "stdio",
            cmd: "node",
            args: ["./build/index.js"],
          },
        ],
      },
    },
    {
      name: "Antigravity",
      schema: AntigravityMcpConfigSchema,
      valid: {
        mcpServers: {
          "auto-doc-mcp": {
            command: "node",
          },
        },
      },
      invalid: {
        mcpServers: "nope",
      },
    },
  ] as const;

  it.each(representativeSchemas)("accepts a valid $name config", ({ schema, valid }) => {
    expect(() => schema.parse(valid)).not.toThrow();
  });

  it.each(representativeSchemas)("rejects an invalid $name config", ({ schema, invalid }) => {
    expect(() => schema.parse(invalid)).toThrow();
  });

  it("exposes matching reusable validators", () => {
    expect(validators.genericMcp({ mcpServers: {} })).toEqual({ mcpServers: {} });
    expect(validators.amazonQ({ mcpServers: {} })).toEqual({ mcpServers: {} });
    expect(validators.openCode({ mcp: { servers: {} } })).toEqual({ mcp: { servers: {} } });
    expect(validators.continueYaml({ mcpServers: [] })).toEqual({ mcpServers: [] });
    expect(validators.vscodeMcp({ servers: {} })).toEqual({ servers: {} });
    expect(validators.zed({ context_servers: {} })).toEqual({ context_servers: {} });
    expect(validators.goose({ extensions: [] })).toEqual({ extensions: [] });
  });
});
