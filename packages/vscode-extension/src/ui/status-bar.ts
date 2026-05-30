import * as vscode from "vscode";

export class StatusBarController {
  readonly item: any;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "autoDocMcp.viewStatus";
    this.item.show();
  }

  setReady(): void {
    this.item.text = "$(pass-filled) Auto-Doc Ready";
    this.item.tooltip = "Auto-Doc MCP is configured and running.";
  }

  setNotConfigured(): void {
    this.item.text = "$(warning) Auto-Doc Setup";
    this.item.tooltip = "Run Auto-Doc setup to configure Notion and MCP integration.";
  }
}
