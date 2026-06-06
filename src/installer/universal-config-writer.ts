// @ts-nocheck
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { isMap, isScalar, isSeq, YAMLMap, YAMLSeq } from "yaml";
import { TOKEN_PLACEHOLDER } from "./token-store.js";
import { validators } from "../validation/index.js";
const HOME = os.homedir();
const PLATFORM = process.platform;
const MCP_STDIO_ENTRY = (serverPath) => ({
    command: "node",
    args: [serverPath],
    env: {
        NOTION_TOKEN: TOKEN_PLACEHOLDER,
    },
});
export function validateMcpServersConfig(input) {
    return validators.genericMcp(input);
}
function buildMcpServersConfig(serverPath) {
    return {
        mcpServers: {
            "auto-doc-mcp": MCP_STDIO_ENTRY(serverPath),
        },
    };
}
export const TOOL_CONFIGS = [
    {
        tool: "Cursor",
        pattern: "mcp-config",
        configPath: path.join(HOME, ".cursor", "mcp.json"),
        format: "mcpServers",
        validator: "genericMcp",
    },
    {
        tool: "Windsurf",
        pattern: "mcp-config",
        configPath: path.join(HOME, ".codeium", "windsurf", "mcp_config.json"),
        format: "mcpServers",
        validator: "genericMcp",
    },
    {
        tool: "Claude Desktop (macOS)",
        pattern: "mcp-config",
        configPath: path.join(HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        format: "mcpServers",
        platform: "darwin",
        validator: "genericMcp",
    },
    {
        tool: "Claude Desktop (Windows)",
        pattern: "mcp-config",
        configPath: path.join(HOME, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
        format: "mcpServers",
        platform: "win32",
        validator: "genericMcp",
    },
    {
        tool: "Claude Desktop (Linux)",
        pattern: "mcp-config",
        configPath: path.join(HOME, ".config", "Claude", "claude_desktop_config.json"),
        format: "mcpServers",
        platform: "linux",
        validator: "genericMcp",
    },
    {
        tool: "Cline (VS Code)",
        pattern: "mcp-config",
        configPath: path.join(HOME, ".vscode", "cline_mcp_settings.json"),
        format: "mcpServers",
        validator: "genericMcp",
    },
    {
        tool: "RooCode (VS Code)",
        pattern: "mcp-config",
        configPath: path.join(HOME, ".vscode", "roo_cline_mcp_settings.json"),
        format: "mcpServers",
        validator: "genericMcp",
    },
    {
        tool: "Kodu AI",
        pattern: "mcp-config",
        configPath: path.join(HOME, ".kodu", "mcp_settings.json"),
        format: "mcpServers",
        validator: "genericMcp",
    },
    {
        tool: "OpenCode",
        pattern: "mcp-config",
        configPath: path.join(HOME, ".config", "opencode", "config.json"),
        format: "mcp",
        validator: "openCode",
    },
    {
        tool: "Goose",
        pattern: "mcp-config",
        configPath: path.join(HOME, ".config", "goose", "config.yaml"),
        format: "goose-yaml",
        validator: "goose",
    },
    {
        tool: "Amazon Q Developer",
        pattern: "mcp-config",
        configPath: path.join(HOME, ".aws", "amazonq", "default.json"),
        format: "mcpServers",
        validator: "amazonQ",
    },
    {
        tool: "Zed",
        pattern: "plugin-config",
        configPath: path.join(HOME, ".config", "zed", "settings.json"),
        format: "zed",
        validator: "zed",
    },
    {
        tool: "Neovim (avante.nvim)",
        pattern: "plugin-config",
        configPath: path.join(HOME, ".config", "nvim", "lua", "mcp-servers.lua"),
        format: "custom",
        generateFn: (serverPath) => `return {\n  ["auto-doc-mcp"] = {\n    command = "node",\n    args = { "${serverPath}" },\n    env = {\n      NOTION_TOKEN = "${TOKEN_PLACEHOLDER}",\n    },\n  },\n}\n`,
    },
    {
        tool: "Emacs (gptel/mcp.el)",
        pattern: "plugin-config",
        configPath: path.join(HOME, ".emacs.d", "mcp-config.el"),
        format: "custom",
        generateFn: (serverPath) => `(with-eval-after-load 'mcp\n  (mcp-add-server\n   :name "auto-doc-mcp"\n   :command "node"\n   :args '("${serverPath}")\n   :env '(("NOTION_TOKEN" . "${TOKEN_PLACEHOLDER}"))))\n`,
    },
    {
        tool: "Helix",
        pattern: "plugin-config",
        configPath: path.join(HOME, ".config", "helix", "config.toml"),
        format: "custom",
        generateFn: (serverPath) => `[language-server.auto-doc-mcp]\ncommand = "node"\nargs = ["${serverPath}"]\nenvironment = { NOTION_TOKEN = "${TOKEN_PLACEHOLDER}" }\n`,
    },
];
export async function writeToAllDetectedTools(serverPath, projectPath) {
    const results = [];
    for (const config of TOOL_CONFIGS) {
        if (config.platform && config.platform !== PLATFORM) {
            continue;
        }
        const toolDir = path.dirname(config.configPath);
        if (!(await directoryExists(toolDir))) {
            results.push({ tool: config.tool, status: "not-installed" });
            continue;
        }
        try {
            await writeConfigForTool(config, serverPath);
            results.push({ tool: config.tool, status: "configured" });
        }
        catch (error) {
            results.push({
                tool: config.tool,
                status: "error",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (projectPath && projectPath.trim().length > 0) {
        await writeWorkspaceConfigs(projectPath, serverPath);
        results.push({ tool: "Workspace .mcp.json", status: "configured" });
        results.push({ tool: "VS Code workspace .vscode/mcp.json", status: "configured" });
        results.push({ tool: "Continue.dev workspace .continue/config.yaml", status: "configured" });
    }
    return results;
}
export async function writeConfigForTool(config, serverPath) {
    if (config.generateFn) {
        const content = config.generateFn(serverPath);
        await fs.mkdir(path.dirname(config.configPath), { recursive: true });
        await fs.writeFile(config.configPath, content, "utf8");
        return;
    }
    const entry = MCP_STDIO_ENTRY(serverPath);
    if (config.format === "mcpServers") {
        await mergeJsonConfig(config.configPath, (existing) => ({
            ...existing,
            mcpServers: {
                ...(asRecord(existing.mcpServers) ?? {}),
                "auto-doc-mcp": entry,
            },
        }), resolveValidator(config.validator ?? "genericMcp"));
        return;
    }
    if (config.format === "mcp") {
        await mergeJsonConfig(config.configPath, (existing) => {
            const mcp = asRecord(existing.mcp) ?? {};
            return {
                ...existing,
                mcp: {
                    ...mcp,
                    servers: {
                        ...(asRecord(mcp.servers) ?? {}),
                        "auto-doc-mcp": entry,
                    },
                },
            };
        }, resolveValidator(config.validator ?? "openCode"));
        return;
    }
    if (config.format === "zed") {
        await mergeJsonConfig(config.configPath, (existing) => ({
            ...existing,
            context_servers: {
                ...(asRecord(existing.context_servers) ?? {}),
                "auto-doc-mcp": {
                    command: {
                        path: "node",
                        args: [serverPath],
                        env: {
                            NOTION_TOKEN: TOKEN_PLACEHOLDER,
                        },
                    },
                    settings: {},
                },
            },
        }), resolveValidator(config.validator ?? "zed"));
        return;
    }
    if (config.format === "goose-yaml") {
        const merged = buildGooseConfig(serverPath);
        resolveValidator(config.validator ?? "goose")(merged);
        const updated = renderGooseConfig(merged);
        await fs.mkdir(path.dirname(config.configPath), { recursive: true });
        await fs.writeFile(config.configPath, updated, "utf8");
        return;
    }
}
export async function writeWorkspaceConfigs(projectPath, serverPath) {
    await mergeJsonConfig(path.join(projectPath, ".mcp.json"), (existing) => ({
        ...existing,
        mcpServers: {
            ...(asRecord(existing.mcpServers) ?? {}),
            "auto-doc-mcp": MCP_STDIO_ENTRY(serverPath),
        },
    }), resolveValidator("genericMcp"));
    await mergeJsonConfig(path.join(projectPath, ".vscode", "mcp.json"), (existing) => ({
        ...existing,
        servers: {
            ...(asRecord(existing.servers) ?? {}),
            "auto-doc-mcp": {
                type: "stdio",
                ...MCP_STDIO_ENTRY(serverPath),
            },
        },
    }), resolveValidator("vscodeMcp"));
    const continueConfig = buildContinueWorkspaceConfig(serverPath);
    const continueConfigPath = path.join(projectPath, ".continue", "config.yaml");
    await fs.mkdir(path.dirname(continueConfigPath), { recursive: true });
    const existingContinueYaml = await readFileOrDefault(continueConfigPath, "");
    const mergedContinueYaml = mergeContinueWorkspaceYaml(existingContinueYaml, continueConfig);
    const parsedMerged = YAML.parse(mergedContinueYaml);
    resolveValidator("continueYaml")(asRecord(parsedMerged) ?? {});
    await fs.writeFile(continueConfigPath, mergedContinueYaml, "utf8");
}
export async function writeWorkspaceMcpJson(projectPath, serverPath) {
    await writeWorkspaceConfigs(projectPath, serverPath);
}
async function mergeJsonConfig(filePath, mergeFn, validator) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const existing = await readJsonOrDefault(filePath);
    const merged = mergeFn(existing);
    if (validator) {
        validator(merged);
    }
    await fs.writeFile(filePath, JSON.stringify(merged, null, 2), "utf8");
}
function resolveValidator(name) {
    return validators[name];
}
function buildGooseConfig(serverPath) {
    return {
        extensions: [
            {
                name: "auto-doc-mcp",
                type: "stdio",
                cmd: "node",
                args: [serverPath],
                env: {
                    NOTION_TOKEN: TOKEN_PLACEHOLDER,
                },
                enabled: true,
            },
        ],
    };
}
function buildContinueWorkspaceConfig(serverPath) {
    return {
        mcpServers: [
            {
                name: "auto-doc-mcp",
                type: "stdio",
                command: "node",
                args: [serverPath],
                env: {
                    NOTION_TOKEN: TOKEN_PLACEHOLDER,
                },
            },
        ],
    };
}
function mergeContinueWorkspaceYaml(existingYaml, generated) {
    const desired = generated.mcpServers[0];
    const createAutoDocServer = () => {
        const server = new YAMLMap();
        server.set("name", desired.name);
        server.set("type", desired.type ?? "stdio");
        server.set("command", desired.command);
        server.set("args", desired.args ?? []);
        const env = new YAMLMap();
        env.set("NOTION_TOKEN", TOKEN_PLACEHOLDER);
        server.set("env", env);
        return server;
    };
    if (existingYaml.trim().length === 0) {
        return YAML.stringify(generated, { indent: 2 });
    }
    const doc = YAML.parseDocument(existingYaml);
    if (doc.errors.length > 0 || !doc.contents || !isMap(doc.contents)) {
        return YAML.stringify(generated, { indent: 2 });
    }
    const root = doc.contents;
    let mcpServersNode = root.get("mcpServers", true);
    let mcpServers;
    if (isSeq(mcpServersNode)) {
        mcpServers = mcpServersNode;
    }
    else {
        mcpServers = new YAMLSeq();
        root.set("mcpServers", mcpServers);
    }
    const autoDocNode = mcpServers.items.find((item) => {
        if (!isMap(item)) {
            return false;
        }
        const nameNode = item.get("name", true);
        return isScalar(nameNode) && nameNode.value === desired.name;
    });
    if (!autoDocNode || !isMap(autoDocNode)) {
        mcpServers.items.push(createAutoDocServer());
        return doc.toString({ indent: 2 });
    }
    autoDocNode.set("name", desired.name);
    autoDocNode.set("type", desired.type ?? "stdio");
    autoDocNode.set("command", desired.command);
    autoDocNode.set("args", desired.args ?? []);
    let envNode = autoDocNode.get("env", true);
    const envMap = isMap(envNode) ? envNode : new YAMLMap();
    if (!isMap(envNode)) {
        autoDocNode.set("env", envMap);
    }
    envMap.set("NOTION_TOKEN", TOKEN_PLACEHOLDER);
    return doc.toString({ indent: 2 });
}
function renderGooseConfig(config) {
    const extension = config.extensions[0];
    const envLine = extension.env
        ? [
            "    env:",
            ...Object.entries(extension.env).map(([key, value]) => `      ${key}: \"${value}\"`),
        ]
        : [];
    return [
        "extensions:",
        `  - name: ${extension.name}`,
        `    type: ${extension.type}`,
        `    cmd: ${extension.cmd}`,
        "    args:",
        ...extension.args.map((arg) => `      - ${arg}`),
        ...envLine,
        `    enabled: ${extension.enabled}`,
        "",
    ].join("\n");
}
async function readJsonOrDefault(filePath) {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        return asRecord(parsed) ?? {};
    }
    catch {
        return {};
    }
}
async function readFileOrDefault(filePath, fallback) {
    try {
        return await fs.readFile(filePath, "utf8");
    }
    catch {
        return fallback;
    }
}
async function directoryExists(dirPath) {
    try {
        await fs.access(dirPath);
        return true;
    }
    catch {
        return false;
    }
}
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
