import * as path from "node:path";
import * as vscode from "vscode";
import { resolveMcpTargets, writeMcpConfig } from "./config-writer";
import { JsonRpcResponseError, JsonRpcStdioClient } from "./jsonrpc-stdio-client";
import {
  buildStatusPanelHtml,
  createErrorStatusPanelState,
  createLoadingStatusPanelState,
  createReadyStatusPanelState,
  type DocumentationStatusPayload,
} from "../ui/status-panel";

type InitializeProjectManualResult = {
  projectId: string;
  projectsDatabaseId?: string;
};

type StatusPanelHandle = ReturnType<typeof vscode.window.createWebviewPanel>;

export class McpServerManager {
  private rpcClient: JsonRpcStdioClient | null = null;
  private statusPanel: StatusPanelHandle | null = null;

  constructor(private readonly context: any) {}

  get serverPath(): string {
    return this.context.asAbsolutePath(path.join("bundled", "mcp-server.js"));
  }

  async isConfigured(): Promise<boolean> {
    const token = await this.context.secrets.get("autoDocMcp.notionToken");
    const databaseId = vscode.workspace.getConfiguration("autoDocMcp").get("notionDatabaseId") as string | undefined;
    return Boolean(token && databaseId && databaseId.trim().length > 0);
  }

  async start(): Promise<void> {
    if (this.rpcClient) {
      return;
    }

    const notionToken = await this.context.secrets.get("autoDocMcp.notionToken");
    if (!notionToken) {
      throw new Error("Notion token not configured");
    }

    this.rpcClient = new JsonRpcStdioClient("node", [this.serverPath], {
      ...process.env,
      NOTION_TOKEN: notionToken,
    });

    await this.rpcClient.start();
  }

  stop(): void {
    this.rpcClient?.stop();
    this.rpcClient = null;
  }

  async writeMcpConfigs(notionToken: string): Promise<void> {
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const targets = resolveMcpTargets(workspacePath);

    for (const target of targets) {
      try {
        await writeMcpConfig(target.filePath, this.serverPath, notionToken);
      } catch (error) {
        console.warn(`Failed to write ${target.name} MCP config`, error);
      }
    }
  }

  async captureCurrentState(): Promise<void> {
    await this.start();
    if (!this.rpcClient) {
      throw new Error("MCP server did not start.");
    }

    const projectId = vscode.workspace.getConfiguration("autoDocMcp").get("projectId") as string | undefined;
    if (!projectId) {
      await vscode.window.showWarningMessage("Auto-Doc project ID is not set. Run setup first.");
      return;
    }

    const { branch, commitSha, filesChanged } = this.getPrimaryRepositorySnapshot();
    const summary = `VS Code capture for ${branch ?? "unknown-branch"}${commitSha ? ` at ${commitSha.slice(0, 7)}` : ""}`;

    const result = await this.rpcClient.callTool("capture_development_event", {
      projectId,
      source: "local_git",
      eventType: "diff",
      summary,
      ...(branch ? { branch } : {}),
      ...(commitSha ? { commitSha } : {}),
      ...(filesChanged ? { filesChanged } : {}),
    });

    const text = this.extractFirstText(result);
    await vscode.window.showInformationMessage(text ? "Auto-Doc capture completed." : "Auto-Doc capture request sent.");
  }

  async openNotionManual(): Promise<void> {
    const dbId = vscode.workspace.getConfiguration("autoDocMcp").get("notionDatabaseId") as string | undefined;
    if (!dbId) {
      await vscode.window.showWarningMessage("No Notion database ID is configured yet.");
      return;
    }

    const normalizedDbId = dbId.replace(/-/g, "");
    await vscode.env.openExternal(vscode.Uri.parse(`https://notion.so/${normalizedDbId}`));
  }

  async showStatusPanel(): Promise<void> {
    const panel = this.getOrCreateStatusPanel();
    panel.reveal(vscode.ViewColumn.Beside);
    panel.webview.html = buildStatusPanelHtml(createLoadingStatusPanelState());
    await this.refreshStatusPanel();
  }

  async initializeProjectManual(input: {
    projectName: string;
    parentPageId: string;
  }): Promise<InitializeProjectManualResult> {
    await this.start();
    if (!this.rpcClient) {
      throw new Error("MCP server did not start.");
    }

    const response = await this.rpcClient.callTool("initialize_project_manual", {
      projectName: input.projectName,
      parentPageId: input.parentPageId,
    });

    const parsed = this.parseToolJson(response) as InitializeProjectManualResult;
    if (!parsed.projectId) {
      throw new Error("initialize_project_manual response did not include projectId.");
    }

    return parsed;
  }

  private parseToolJson(result: unknown): unknown {
    const text = this.extractFirstText(result);
    if (!text) {
      throw new Error("MCP tool call did not include text content.");
    }

    return JSON.parse(text);
  }

  private getOrCreateStatusPanel(): StatusPanelHandle {
    if (this.statusPanel) {
      return this.statusPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "autoDocMcp.status",
      "Auto-Doc Status",
      vscode.ViewColumn.Beside,
      {
        enableFindWidget: true,
        enableScripts: true,
      },
    );

    panel.onDidDispose(() => {
      if (this.statusPanel === panel) {
        this.statusPanel = null;
      }
    });

    panel.webview.onDidReceiveMessage(async (message: { type?: string; traceId?: string }) => {
      if (message.type === "refresh") {
        panel.webview.html = buildStatusPanelHtml(createLoadingStatusPanelState("Refreshing documentation status..."));
        await this.refreshStatusPanel();
        return;
      }

      if (message.type === "copyTraceId" && message.traceId) {
        await vscode.env.clipboard.writeText(message.traceId);
        await vscode.window.showInformationMessage(`Copied trace ID ${message.traceId}`);
        return;
      }

      if (message.type === "openSetup") {
        await vscode.commands.executeCommand("autoDocMcp.setup");
        return;
      }

      if (message.type === "openSettings") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "autoDocMcp");
      }
    });

    this.statusPanel = panel;
    return panel;
  }

  private async refreshStatusPanel(): Promise<void> {
    if (!this.statusPanel) {
      return;
    }

    const projectId = vscode.workspace.getConfiguration("autoDocMcp").get("projectId") as string | undefined;
    if (!projectId) {
      this.statusPanel.webview.html = buildStatusPanelHtml(
        createErrorStatusPanelState("Auto-Doc project ID is not set.", {
          details: "Run the setup wizard to initialize a project and save the returned project ID in extension settings.",
          allowSetupAction: true,
          allowSettingsAction: true,
        }),
      );
      return;
    }

    try {
      await this.start();
      if (!this.rpcClient) {
        throw new Error("MCP server did not start.");
      }

      const result = await this.rpcClient.callTool("get_documentation_status", {
        projectId,
      });

      const parsed = this.parseToolJson(result);
      const structuredError = this.getStructuredToolError(parsed);
      if (structuredError) {
        this.statusPanel.webview.html = buildStatusPanelHtml(
          createErrorStatusPanelState(structuredError.message, {
            details: structuredError.details,
            traceId: structuredError.traceId,
          }),
        );
        return;
      }

      this.statusPanel.webview.html = buildStatusPanelHtml(createReadyStatusPanelState(parsed as DocumentationStatusPayload));
    } catch (error) {
      this.statusPanel.webview.html = buildStatusPanelHtml(this.createStatusPanelErrorState(error));
    }
  }

  private getStructuredToolError(value: unknown): { message: string; details?: string; traceId?: string } | null {
    if (typeof value !== "object" || value === null) {
      return null;
    }

    const errorEnvelope = value as {
      ok?: boolean;
      error?: {
        code?: string;
        message?: string;
        traceId?: string;
        tool?: string;
        remediation?: string[];
        causeName?: string;
      };
    };

    if (errorEnvelope.ok !== false || !errorEnvelope.error?.message) {
      return null;
    }

    const detailsParts = [
      errorEnvelope.error.code ? `Code: ${errorEnvelope.error.code}` : null,
      errorEnvelope.error.tool ? `Tool: ${errorEnvelope.error.tool}` : null,
      errorEnvelope.error.causeName ? `Cause: ${errorEnvelope.error.causeName}` : null,
      errorEnvelope.error.remediation?.length ? `Remediation: ${errorEnvelope.error.remediation.join(" | ")}` : null,
    ].filter((value): value is string => Boolean(value));

    return {
      message: errorEnvelope.error.message,
      details: detailsParts.length > 0 ? detailsParts.join("\n") : undefined,
      traceId: errorEnvelope.error.traceId,
    };
  }

  private createStatusPanelErrorState(error: unknown) {
    if (error instanceof JsonRpcResponseError) {
      const structuredFromData = this.getStructuredToolError(error.data);
      if (structuredFromData) {
        return createErrorStatusPanelState(structuredFromData.message, {
          details: structuredFromData.details,
          traceId: structuredFromData.traceId,
          allowSettingsAction: true,
        });
      }
    }

    if (error instanceof Error) {
      const parsedMessage = this.tryParseJson(error.message);
      const structuredFromMessage = this.getStructuredToolError(parsedMessage);
      if (structuredFromMessage) {
        return createErrorStatusPanelState(structuredFromMessage.message, {
          details: structuredFromMessage.details,
          traceId: structuredFromMessage.traceId,
          allowSetupAction: structuredFromMessage.message.includes("Notion token not configured"),
          allowSettingsAction: true,
        });
      }

      return createErrorStatusPanelState(error.message, {
        allowSetupAction: error.message.includes("Notion token not configured"),
        allowSettingsAction: true,
      });
    }

    return createErrorStatusPanelState(String(error), {
      allowSettingsAction: true,
    });
  }

  private tryParseJson(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private extractFirstText(result: unknown): string | null {
    const asRecord = result as {
      content?: Array<{ type?: string; text?: string }>;
    };

    const first = asRecord.content?.find((item) => item.type === "text" && typeof item.text === "string");
    return first?.text ?? null;
  }

  private getPrimaryRepositorySnapshot(): {
    branch: string | null;
    commitSha: string | null;
    filesChanged: string | null;
  } {
    const gitExtension = vscode.extensions.getExtension("vscode.git");
    if (!gitExtension?.isActive) {
      return { branch: null, commitSha: null, filesChanged: null };
    }

    const gitApi = gitExtension.exports.getAPI(1);
    const repository = gitApi.repositories[0];
    if (!repository) {
      return { branch: null, commitSha: null, filesChanged: null };
    }

    const branch = repository.state.HEAD?.name ?? null;
    const commitSha = repository.state.HEAD?.commit ?? null;

    const allChanges = [
      ...(repository.state.indexChanges ?? []),
      ...(repository.state.workingTreeChanges ?? []),
      ...(repository.state.mergeChanges ?? []),
    ];

    const files = allChanges
      .map((change: { uri?: { fsPath?: string } }) => change.uri?.fsPath)
      .filter((value: string | undefined): value is string => Boolean(value));

    return {
      branch,
      commitSha,
      filesChanged: files.length > 0 ? files.join(",") : null,
    };
  }
}
