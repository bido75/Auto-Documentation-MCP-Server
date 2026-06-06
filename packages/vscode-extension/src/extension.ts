import * as vscode from "vscode";
import { AuthManager } from "./auth/authManager";
import { AuthStatusBarController } from "./ui/authStatusBar";
import { AuthWebviewController } from "./ui/authWebview";

let authStatusBar: AuthStatusBarController | undefined;
let authWebview: AuthWebviewController | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const auth = new AuthManager(context);

  authWebview = new AuthWebviewController(context, auth, async () => {
    await authStatusBar?.refresh();
  });

  authStatusBar = new AuthStatusBarController(auth, () => {
    void authWebview?.show();
  });

  context.subscriptions.push(authStatusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("autoDocMcp.openAuth", (focusToken?: boolean) => authWebview?.show({ focusToken })),
    vscode.commands.registerCommand("autoDocMcp.updateToken", async () => {
      const existing = await auth.getToken();
      const token = await vscode.window.showInputBox({
        title: "Auto-Doc: Update Login Token",
        prompt: "Paste the new token. It will replace the currently stored token.",
        password: true,
        ignoreFocusOut: true,
        value: existing ?? "",
        validateInput: (value) => (value.trim().length > 0 ? null : "Token cannot be empty."),
      });

      if (!token) {
        return;
      }

      await auth.updateToken(token);
      await authStatusBar?.refresh();
      await vscode.window.showInformationMessage("Auto-Doc: Login token updated.");
    }),
    vscode.commands.registerCommand("autoDocMcp.login", () => authWebview?.show()),
    vscode.commands.registerCommand("autoDocMcp.logout", async () => {
      await auth.signOut();
      await authStatusBar?.refresh();
      await vscode.window.showInformationMessage("Auto-Doc: Logged out successfully.");
    }),
  );

  await authStatusBar.refresh();

  if (!(await auth.isSignedIn())) {
    const action = await vscode.window.showInformationMessage(
      "Auto-Doc is installed. Open the login page to sign in.",
      "Open Login Page",
    );
    if (action === "Open Login Page") {
      void authWebview.show();
    }
  }
}

export function deactivate() {
  authStatusBar?.dispose();
}