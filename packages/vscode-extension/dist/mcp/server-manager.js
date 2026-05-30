"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpServerManager = void 0;
const path = __importStar(require("node:path"));
const vscode = __importStar(require("vscode"));
const config_writer_1 = require("./config-writer");
const jsonrpc_stdio_client_1 = require("./jsonrpc-stdio-client");
const status_panel_1 = require("../ui/status-panel");
class McpServerManager {
    context;
    rpcClient = null;
    statusPanel = null;
    constructor(context) {
        this.context = context;
    }
    get serverPath() {
        return this.context.asAbsolutePath(path.join("bundled", "mcp-server.js"));
    }
    async isConfigured() {
        const token = await this.context.secrets.get("autoDocMcp.notionToken");
        const databaseId = vscode.workspace.getConfiguration("autoDocMcp").get("notionDatabaseId");
        return Boolean(token && databaseId && databaseId.trim().length > 0);
    }
    async start() {
        if (this.rpcClient) {
            return;
        }
        const notionToken = await this.context.secrets.get("autoDocMcp.notionToken");
        if (!notionToken) {
            throw new Error("Notion token not configured");
        }
        this.rpcClient = new jsonrpc_stdio_client_1.JsonRpcStdioClient("node", [this.serverPath], {
            ...process.env,
            NOTION_TOKEN: notionToken,
        });
        await this.rpcClient.start();
    }
    stop() {
        this.rpcClient?.stop();
        this.rpcClient = null;
    }
    async writeMcpConfigs(notionToken) {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const targets = (0, config_writer_1.resolveMcpTargets)(workspacePath);
        for (const target of targets) {
            try {
                await (0, config_writer_1.writeMcpConfig)(target.filePath, this.serverPath, notionToken);
            }
            catch (error) {
                console.warn(`Failed to write ${target.name} MCP config`, error);
            }
        }
    }
    async captureCurrentState() {
        await this.start();
        if (!this.rpcClient) {
            throw new Error("MCP server did not start.");
        }
        const projectId = vscode.workspace.getConfiguration("autoDocMcp").get("projectId");
        if (!projectId) {
            await vscode.window.showWarningMessage("Auto-Doc project ID is not set. Run setup first.");
            return;
        }
        const { branch, commitSha, filesChanged } = this.getPrimaryRepositorySnapshot();
        const summary = `VS Code capture for ${branch ?? "unknown-branch"}${commitSha ? ` at ${commitSha.slice(0, 7)}` : ""}`;
        const result = await this.rpcClient.callTool("capture_development_event", {
            projectId,
            source: "local_git",
            eventType: "diff",
            summary,
            ...(branch ? { branch } : {}),
            ...(commitSha ? { commitSha } : {}),
            ...(filesChanged ? { filesChanged } : {}),
        });
        const text = this.extractFirstText(result);
        await vscode.window.showInformationMessage(text ? "Auto-Doc capture completed." : "Auto-Doc capture request sent.");
    }
    async openNotionManual() {
        const dbId = vscode.workspace.getConfiguration("autoDocMcp").get("notionDatabaseId");
        if (!dbId) {
            await vscode.window.showWarningMessage("No Notion database ID is configured yet.");
            return;
        }
        const normalizedDbId = dbId.replace(/-/g, "");
        await vscode.env.openExternal(vscode.Uri.parse(`https://notion.so/${normalizedDbId}`));
    }
    async showStatusPanel() {
        const panel = this.getOrCreateStatusPanel();
        panel.reveal(vscode.ViewColumn.Beside);
        panel.webview.html = (0, status_panel_1.buildStatusPanelHtml)((0, status_panel_1.createLoadingStatusPanelState)());
        await this.refreshStatusPanel();
    }
    async initializeProjectManual(input) {
        await this.start();
        if (!this.rpcClient) {
            throw new Error("MCP server did not start.");
        }
        const response = await this.rpcClient.callTool("initialize_project_manual", {
            projectName: input.projectName,
            parentPageId: input.parentPageId,
        });
        const parsed = this.parseToolJson(response);
        if (!parsed.projectId) {
            throw new Error("initialize_project_manual response did not include projectId.");
        }
        return parsed;
    }
    parseToolJson(result) {
        const text = this.extractFirstText(result);
        if (!text) {
            throw new Error("MCP tool call did not include text content.");
        }
        return JSON.parse(text);
    }
    getOrCreateStatusPanel() {
        if (this.statusPanel) {
            return this.statusPanel;
        }
        const panel = vscode.window.createWebviewPanel("autoDocMcp.status", "Auto-Doc Status", vscode.ViewColumn.Beside, {
            enableFindWidget: true,
            enableScripts: true,
        });
        panel.onDidDispose(() => {
            if (this.statusPanel === panel) {
                this.statusPanel = null;
            }
        });
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.type === "refresh") {
                panel.webview.html = (0, status_panel_1.buildStatusPanelHtml)((0, status_panel_1.createLoadingStatusPanelState)("Refreshing documentation status..."));
                await this.refreshStatusPanel();
                return;
            }
            if (message.type === "copyTraceId" && message.traceId) {
                await vscode.env.clipboard.writeText(message.traceId);
                await vscode.window.showInformationMessage(`Copied trace ID ${message.traceId}`);
                return;
            }
            if (message.type === "openSetup") {
                await vscode.commands.executeCommand("autoDocMcp.setup");
                return;
            }
            if (message.type === "openSettings") {
                await vscode.commands.executeCommand("workbench.action.openSettings", "autoDocMcp");
            }
        });
        this.statusPanel = panel;
        return panel;
    }
    async refreshStatusPanel() {
        if (!this.statusPanel) {
            return;
        }
        const projectId = vscode.workspace.getConfiguration("autoDocMcp").get("projectId");
        if (!projectId) {
            this.statusPanel.webview.html = (0, status_panel_1.buildStatusPanelHtml)((0, status_panel_1.createErrorStatusPanelState)("Auto-Doc project ID is not set.", {
                details: "Run the setup wizard to initialize a project and save the returned project ID in extension settings.",
                allowSetupAction: true,
                allowSettingsAction: true,
            }));
            return;
        }
        try {
            await this.start();
            if (!this.rpcClient) {
                throw new Error("MCP server did not start.");
            }
            const result = await this.rpcClient.callTool("get_documentation_status", {
                projectId,
            });
            const parsed = this.parseToolJson(result);
            const structuredError = this.getStructuredToolError(parsed);
            if (structuredError) {
                this.statusPanel.webview.html = (0, status_panel_1.buildStatusPanelHtml)((0, status_panel_1.createErrorStatusPanelState)(structuredError.message, {
                    details: structuredError.details,
                    traceId: structuredError.traceId,
                }));
                return;
            }
            this.statusPanel.webview.html = (0, status_panel_1.buildStatusPanelHtml)((0, status_panel_1.createReadyStatusPanelState)(parsed));
        }
        catch (error) {
            this.statusPanel.webview.html = (0, status_panel_1.buildStatusPanelHtml)(this.createStatusPanelErrorState(error));
        }
    }
    getStructuredToolError(value) {
        if (typeof value !== "object" || value === null) {
            return null;
        }
        const errorEnvelope = value;
        if (errorEnvelope.ok !== false || !errorEnvelope.error?.message) {
            return null;
        }
        const detailsParts = [
            errorEnvelope.error.code ? `Code: ${errorEnvelope.error.code}` : null,
            errorEnvelope.error.tool ? `Tool: ${errorEnvelope.error.tool}` : null,
            errorEnvelope.error.causeName ? `Cause: ${errorEnvelope.error.causeName}` : null,
            errorEnvelope.error.remediation?.length ? `Remediation: ${errorEnvelope.error.remediation.join(" | ")}` : null,
        ].filter((value) => Boolean(value));
        return {
            message: errorEnvelope.error.message,
            details: detailsParts.length > 0 ? detailsParts.join("\n") : undefined,
            traceId: errorEnvelope.error.traceId,
        };
    }
    createStatusPanelErrorState(error) {
        if (error instanceof jsonrpc_stdio_client_1.JsonRpcResponseError) {
            const structuredFromData = this.getStructuredToolError(error.data);
            if (structuredFromData) {
                return (0, status_panel_1.createErrorStatusPanelState)(structuredFromData.message, {
                    details: structuredFromData.details,
                    traceId: structuredFromData.traceId,
                    allowSettingsAction: true,
                });
            }
        }
        if (error instanceof Error) {
            const parsedMessage = this.tryParseJson(error.message);
            const structuredFromMessage = this.getStructuredToolError(parsedMessage);
            if (structuredFromMessage) {
                return (0, status_panel_1.createErrorStatusPanelState)(structuredFromMessage.message, {
                    details: structuredFromMessage.details,
                    traceId: structuredFromMessage.traceId,
                    allowSetupAction: structuredFromMessage.message.includes("Notion token not configured"),
                    allowSettingsAction: true,
                });
            }
            return (0, status_panel_1.createErrorStatusPanelState)(error.message, {
                allowSetupAction: error.message.includes("Notion token not configured"),
                allowSettingsAction: true,
            });
        }
        return (0, status_panel_1.createErrorStatusPanelState)(String(error), {
            allowSettingsAction: true,
        });
    }
    tryParseJson(text) {
        try {
            return JSON.parse(text);
        }
        catch {
            return null;
        }
    }
    extractFirstText(result) {
        const asRecord = result;
        const first = asRecord.content?.find((item) => item.type === "text" && typeof item.text === "string");
        return first?.text ?? null;
    }
    getPrimaryRepositorySnapshot() {
        const gitExtension = vscode.extensions.getExtension("vscode.git");
        if (!gitExtension?.isActive) {
            return { branch: null, commitSha: null, filesChanged: null };
        }
        const gitApi = gitExtension.exports.getAPI(1);
        const repository = gitApi.repositories[0];
        if (!repository) {
            return { branch: null, commitSha: null, filesChanged: null };
        }
        const branch = repository.state.HEAD?.name ?? null;
        const commitSha = repository.state.HEAD?.commit ?? null;
        const allChanges = [
            ...(repository.state.indexChanges ?? []),
            ...(repository.state.workingTreeChanges ?? []),
            ...(repository.state.mergeChanges ?? []),
        ];
        const files = allChanges
            .map((change) => change.uri?.fsPath)
            .filter((value) => Boolean(value));
        return {
            branch,
            commitSha,
            filesChanged: files.length > 0 ? files.join(",") : null,
        };
    }
}
exports.McpServerManager = McpServerManager;
