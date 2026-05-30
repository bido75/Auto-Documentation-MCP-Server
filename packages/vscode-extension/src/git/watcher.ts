import * as vscode from "vscode";

export class GitWatcher {
  private disposables: any[] = [];
  private lastHeadSha: string | null = null;

  start(): void {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension?.isActive) {
      return;
    }

    const gitApi = gitExtension.exports.getAPI(1);

    for (const repository of gitApi.repositories) {
      this.watchRepository(repository);
    }

    this.disposables.push(gitApi.onDidOpenRepository((repository: unknown) => this.watchRepository(repository)));
  }

  stop(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.disposables = [];
  }

  private watchRepository(repository: unknown): void {
    const repo = repository as {
      state: {
        HEAD?: { commit?: string };
        onDidChange: (listener: () => void) => any;
      };
    };

    this.disposables.push(
      repo.state.onDidChange(() => {
        const captureOnCommit = (vscode.workspace.getConfiguration("autoDocMcp").get("captureOnCommit", true) as boolean) ?? true;
        if (!captureOnCommit) {
          return;
        }

        const currentHead = repo.state.HEAD?.commit ?? null;
        if (!currentHead || currentHead === this.lastHeadSha) {
          return;
        }

        this.lastHeadSha = currentHead;
        void vscode.commands.executeCommand("autoDocMcp.captureNow");
      }),
    );
  }
}
