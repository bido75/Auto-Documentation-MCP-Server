import * as vscode from "vscode";
import { AuthManager } from "../auth/authManager";

export class AuthStatusBarController implements vscode.Disposable {
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly actionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);

  constructor(
    private readonly auth: AuthManager,
    private readonly openAuthPage: () => void,
  ) {
    this.statusItem.command = { command: "autoDocMcp.openAuth", arguments: [true] };
    this.statusItem.tooltip = "Open the Auto-Doc login page";

    this.actionItem.command = { command: "autoDocMcp.openAuth", arguments: [true] };
    this.actionItem.tooltip = "Open the Auto-Doc login page";
  }

  async refresh(): Promise<void> {
    const token = await this.auth.getToken();
    const hasToken = Boolean(token);

    this.statusItem.text = hasToken
      ? "$(check) Auto-Doc: Update token"
      : "$(circle-slash) Auto-Doc: Change token";
    this.statusItem.show();

    this.actionItem.text = hasToken
      ? "$(edit) Update token"
      : "$(sign-in) Change token";
    this.actionItem.command = { command: "autoDocMcp.openAuth", arguments: [true] };
    this.actionItem.tooltip = hasToken
      ? "Open the Auto-Doc login page to update the stored token"
      : "Open the Auto-Doc login page to add a token";
    this.actionItem.show();
  }

  dispose(): void {
    this.statusItem.dispose();
    this.actionItem.dispose();
  }
}