import * as vscode from "vscode";
import { McpServerManager } from "../mcp/server-manager";

export class SetupWizard {
  constructor(
    private readonly context: any,
    private readonly serverManager: McpServerManager,
  ) {}

  async run(): Promise<void> {
    const token = await vscode.window.showInputBox({
      title: "Auto-Doc Setup (1/3) - Notion Token",
      prompt: "Paste your Notion integration token.",
      placeHolder: "secret_xxxxxxxxxxxxxxxxxxxx",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value: string) => {
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
      validateInput: (value: string) => {
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

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Auto-Doc setup in progress",
        cancellable: false,
      },
      async (progress: any) => {
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
          .update(
            "notionDatabaseId",
            initializeResult.projectsDatabaseId ?? initializeResult.projectId,
            vscode.ConfigurationTarget.Workspace,
          );

        progress.report({ message: "Writing MCP config files..." });
        await this.serverManager.writeMcpConfigs(token);

        progress.report({ message: "Starting bundled MCP server..." });
        await this.serverManager.start();
      },
    );

    const action = await vscode.window.showInformationMessage(
      `Auto-Doc is ready for ${projectName}.`,
      "Open Manual",
      "Done",
    );

    if (action === "Open Manual") {
      await vscode.commands.executeCommand("autoDocMcp.openManual");
    }
  }
}
