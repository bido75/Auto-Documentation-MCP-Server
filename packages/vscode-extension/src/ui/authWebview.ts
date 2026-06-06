import * as vscode from "vscode";
import { AuthManager } from "../auth/authManager";

type AuthMessage =
  | { type: "login"; token: string }
  | { type: "logout" };

export class AuthWebviewController {
  private panel: vscode.WebviewPanel | null = null;
  private focusTokenOnShow = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly auth: AuthManager,
    private readonly onAuthChanged: () => Promise<void> | void,
  ) {}

  async show(options?: { focusToken?: boolean }): Promise<void> {
    this.focusTokenOnShow = Boolean(options?.focusToken);

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      await this.postState();
      if (this.focusTokenOnShow) {
        await this.focusTokenField();
      }
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "autoDocMcpAuth",
      "Auto-Doc: Login",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.onDidDispose(() => {
      this.panel = null;
    });

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((message: AuthMessage) => {
      void this.handleMessage(message);
    });

    await this.postState();
    if (this.focusTokenOnShow) {
      await this.focusTokenField();
    }
  }

  private async handleMessage(message: AuthMessage): Promise<void> {
    if (message.type === "login") {
      try {
        await this.auth.signIn(message.token);
        await this.onAuthChanged();
        await this.postState("Logged in successfully.");
        await this.panel?.webview.postMessage({ type: "clear-token" });
        await this.focusTokenField();
      } catch (error) {
        await this.postState(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    await this.auth.signOut();
    await this.onAuthChanged();
    await this.postState("Logged out successfully.");
  }

  private async postState(message?: string): Promise<void> {
    if (!this.panel) {
      return;
    }

    const signedIn = await this.auth.isSignedIn();
    const token = await this.auth.getToken();
    this.panel.webview.postMessage({
      type: "state",
      signedIn,
      hasToken: Boolean(token),
      message: message ?? (signedIn ? "Signed in" : "Signed out"),
    });
  }

  private async focusTokenField(): Promise<void> {
    if (!this.panel) {
      return;
    }

    await this.panel.webview.postMessage({ type: "focus-token" });
    this.focusTokenOnShow = false;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = this.createNonce();
    const cspSource = webview.cspSource;

    return `<!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <title>Auto-Doc Login</title>
        <style>
          :root { color-scheme: light; }
          body {
            margin: 0;
            padding: 24px;
            background: linear-gradient(180deg, #f7f9fc 0%, #ffffff 100%);
            color: #111827;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          main {
            max-width: 640px;
            margin: 0 auto;
            background: #fff;
            border: 1px solid #d7dde5;
            border-radius: 16px;
            padding: 28px;
            box-shadow: 0 12px 36px rgba(15, 23, 42, 0.08);
          }
          h1 { margin-top: 0; margin-bottom: 8px; font-size: 1.75rem; }
          p { line-height: 1.5; }
          label { display: block; margin-top: 20px; font-weight: 700; }
          input {
            width: 100%;
            box-sizing: border-box;
            padding: 12px 14px;
            border: 1px solid #b8c2cf;
            border-radius: 10px;
            margin-top: 8px;
            font-size: 1rem;
          }
          input:focus, button:focus {
            outline: 3px solid #7aa7ff;
            outline-offset: 2px;
          }
          .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
          button {
            border: 0;
            border-radius: 10px;
            padding: 12px 16px;
            cursor: pointer;
            font-weight: 700;
            font-size: 0.98rem;
          }
          .primary { background: #0f62fe; color: #fff; }
          .secondary { background: #e5e7eb; color: #111827; }
          .tertiary { background: transparent; color: #0f62fe; text-decoration: underline; }
          .status {
            margin-top: 18px;
            min-height: 1.5rem;
            padding: 12px 14px;
            border-radius: 10px;
            background: #f3f4f6;
          }
          .hint { color: #4b5563; font-size: 0.95rem; }
        </style>
      </head>
      <body>
        <main aria-labelledby="login-title">
          <h1 id="login-title">Auto-Doc Login</h1>
          <p class="hint">Enter your token to sign in. Use Logout to clear the stored token and end the session.</p>
          <form id="auth-form">
            <label for="token">Access token</label>
            <input
              id="token"
              name="token"
              type="password"
              autocomplete="current-password"
              autocapitalize="off"
              spellcheck="false"
              aria-describedby="status help"
            />
            <div id="help" class="hint">The token is stored securely in VS Code SecretStorage, not in plain text.</div>
            <div class="actions">
              <button class="primary" id="login-btn" type="submit">Login</button>
              <button class="secondary" id="change-btn" type="button">Change token</button>
              <button class="secondary" id="logout-btn" type="button">Logout</button>
              <button class="tertiary" id="clear-btn" type="button">Clear field</button>
            </div>
          </form>
          <div id="status" class="status" role="status" aria-live="polite">Signed out</div>
        </main>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const form = document.getElementById('auth-form');
          const tokenInput = document.getElementById('token');
          const status = document.getElementById('status');
          const changeBtn = document.getElementById('change-btn');
          const clearBtn = document.getElementById('clear-btn');
          const logoutBtn = document.getElementById('logout-btn');

          changeBtn.textContent = 'Change token';

          form.addEventListener('submit', (event) => {
            event.preventDefault();
            vscode.postMessage({ type: 'login', token: tokenInput.value });
          });

          changeBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'login', token: tokenInput.value });
          });

          logoutBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'logout' });
            tokenInput.value = '';
          });

          clearBtn.addEventListener('click', () => {
            tokenInput.value = '';
            tokenInput.focus();
          });

          window.addEventListener('message', (event) => {
            const message = event.data;
            if (message?.type === 'state') {
              status.textContent = message.message || (message.signedIn ? 'Signed in' : 'Signed out');
              changeBtn.textContent = message.hasToken ? 'Update token' : 'Change token';
              tokenInput.setAttribute('aria-invalid', 'false');
            }

            if (message?.type === 'clear-token') {
              tokenInput.value = '';
            }

            if (message?.type === 'focus-token') {
              tokenInput.focus();
              tokenInput.select();
            }
          });
        </script>
      </body>
      </html>`;
  }

  private createNonce(): string {
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let value = "";
    for (let index = 0; index < 32; index += 1) {
      value += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return value;
  }
}