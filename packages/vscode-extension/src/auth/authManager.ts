import * as vscode from "vscode";

const NOTION_TOKEN_KEY = "autoDocMcp.notionToken";

export class AuthManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getToken(): Promise<string | undefined> {
    return this.context.secrets.get(NOTION_TOKEN_KEY);
  }

  async isSignedIn(): Promise<boolean> {
    return Boolean(await this.getToken());
  }

  async signIn(token: string): Promise<void> {
    const resolvedToken = token.trim();
    if (!resolvedToken) {
      throw new Error("Enter a token before signing in.");
    }

    await this.context.secrets.store(NOTION_TOKEN_KEY, resolvedToken);
    await this.context.globalState.update("autoDocMcp.signedIn", true);
  }

  async updateToken(token: string): Promise<void> {
    await this.signIn(token);
  }

  async signOut(): Promise<void> {
    await this.context.secrets.delete(NOTION_TOKEN_KEY);
    await this.context.globalState.update("autoDocMcp.signedIn", false);
  }
}