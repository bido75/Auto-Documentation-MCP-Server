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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const watcher_1 = require("./git/watcher");
const server_manager_1 = require("./mcp/server-manager");
const wizard_1 = require("./setup/wizard");
const status_bar_1 = require("./ui/status-bar");
let serverManager;
let gitWatcher;
let statusBar;
async function activate(context) {
    statusBar = new status_bar_1.StatusBarController();
    serverManager = new server_manager_1.McpServerManager(context);
    gitWatcher = new watcher_1.GitWatcher();
    context.subscriptions.push(statusBar.item);
    context.subscriptions.push(vscode.commands.registerCommand("autoDocMcp.setup", async () => {
        if (!serverManager) {
            return;
        }
        const wizard = new wizard_1.SetupWizard(context, serverManager);
        await wizard.run();
    }), vscode.commands.registerCommand("autoDocMcp.captureNow", async () => {
        if (!serverManager) {
            return;
        }
        await serverManager.captureCurrentState();
    }), vscode.commands.registerCommand("autoDocMcp.openManual", async () => {
        if (!serverManager) {
            return;
        }
        await serverManager.openNotionManual();
    }), vscode.commands.registerCommand("autoDocMcp.viewStatus", async () => {
        if (!serverManager) {
            return;
        }
        await serverManager.showStatusPanel();
    }));
    if (await serverManager.isConfigured()) {
        await serverManager.start();
        gitWatcher.start();
        statusBar.setReady();
        return;
    }
    statusBar.setNotConfigured();
    const action = await vscode.window.showInformationMessage("Auto-Doc MCP is installed. Run setup to connect your Notion workspace.", "Run Setup");
    if (action === "Run Setup") {
        await vscode.commands.executeCommand("autoDocMcp.setup");
    }
}
async function deactivate() {
    gitWatcher?.stop();
    serverManager?.stop();
}
