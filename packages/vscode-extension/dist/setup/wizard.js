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
exports.SetupWizard = void 0;
const vscode = __importStar(require("vscode"));
class SetupWizard {
    context;
    serverManager;
    constructor(context, serverManager) {
        this.context = context;
        this.serverManager = serverManager;
    }
    async run() {
        const token = await vscode.window.showInputBox({
            title: "Auto-Doc Setup (1/3) - Notion Token",
            prompt: "Paste your Notion integration token.",
            placeHolder: "secret_xxxxxxxxxxxxxxxxxxxx",
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (value.startsWith("secret_")) {
                    return null;
                }
                return "Token must start with secret_.";
            },
        });
        if (!token) {
            return;
        }
        await this.context.secrets.store("autoDocMcp.notionToken", token);
        const parentPageId = await vscode.window.showInputBox({
            title: "Auto-Doc Setup (2/3) - Notion Parent Page ID",
            prompt: "Paste the 32-character Notion page ID.",
            ignoreFocusOut: true,
            validateInput: (value) => {
                const normalized = value.replace(/-/g, "");
                if (normalized.length === 32) {
                    return null;
                }
                return "Page ID must be 32 characters after removing dashes.";
            },
        });
        if (!parentPageId) {
            return;
        }
        const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? "My Project";
        const projectName = await vscode.window.showInputBox({
            title: "Auto-Doc Setup (3/3) - Project Name",
            value: workspaceName,
            ignoreFocusOut: true,
        });
        if (!projectName) {
            return;
        }
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Auto-Doc setup in progress",
            cancellable: false,
        }, async (progress) => {
            progress.report({ message: "Initializing project metadata..." });
            const initializeResult = await this.serverManager.initializeProjectManual({
                projectName,
                parentPageId,
            });
            progress.report({ message: "Saving workspace settings..." });
            await vscode.workspace
                .getConfiguration("autoDocMcp")
                .update("projectId", initializeResult.projectId, vscode.ConfigurationTarget.Workspace);
            await vscode.workspace
                .getConfiguration("autoDocMcp")
                .update("notionDatabaseId", initializeResult.projectsDatabaseId ?? initializeResult.projectId, vscode.ConfigurationTarget.Workspace);
            progress.report({ message: "Writing MCP config files..." });
            await this.serverManager.writeMcpConfigs(token);
            progress.report({ message: "Starting bundled MCP server..." });
            await this.serverManager.start();
        });
        const action = await vscode.window.showInformationMessage(`Auto-Doc is ready for ${projectName}.`, "Open Manual", "Done");
        if (action === "Open Manual") {
            await vscode.commands.executeCommand("autoDocMcp.openManual");
        }
    }
}
exports.SetupWizard = SetupWizard;
