import * as vscode from "vscode";
import { GitWatcher } from "./git/watcher";
import { McpServerManager } from "./mcp/server-manager";
import { SetupWizard } from "./setup/wizard";
import { StatusBarController } from "./ui/status-bar";

let serverManager: McpServerManager | undefined;
let gitWatcher: GitWatcher | undefined;
let statusBar: StatusBarController | undefined;

export async function activate(context: any): Promise<void> {
  statusBar = new StatusBarController();
  serverManager = new McpServerManager(context);
  gitWatcher = new GitWatcher();

  context.subscriptions.push(statusBar.item);

  context.subscriptions.push(
    vscode.commands.registerCommand("autoDocMcp.setup", async () => {
      if (!serverManager) {
        return;
      }

      const wizard = new SetupWizard(context, serverManager);
      await wizard.run();
    }),
    vscode.commands.registerCommand("autoDocMcp.captureNow", async () => {
      if (!serverManager) {
        return;
      }

      await serverManager.captureCurrentState();
    }),
    vscode.commands.registerCommand("autoDocMcp.openManual", async () => {
      if (!serverManager) {
        return;
      }

      await serverManager.openNotionManual();
    }),
    vscode.commands.registerCommand("autoDocMcp.viewStatus", async () => {
      if (!serverManager) {
        return;
      }

      await serverManager.showStatusPanel();
    }),
  );

  if (await serverManager.isConfigured()) {
    await serverManager.start();
    gitWatcher.start();
    statusBar.setReady();
    return;
  }

  statusBar.setNotConfigured();
  const action = await vscode.window.showInformationMessage(
    "Auto-Doc MCP is installed. Run setup to connect your Notion workspace.",
    "Run Setup",
  );

  if (action === "Run Setup") {
    await vscode.commands.executeCommand("autoDocMcp.setup");
  }
}

export async function deactivate(): Promise<void> {
  gitWatcher?.stop();
  serverManager?.stop();
}
