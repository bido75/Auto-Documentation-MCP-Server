import { McpServerManager } from "../mcp/server-manager";

export type NotionSetupResult = {
  projectId: string;
  projectsDatabaseId?: string;
};

export class NotionSetup {
  constructor(private readonly serverManager: McpServerManager) {}

  async initializeProjectManual(projectName: string, parentPageId: string): Promise<NotionSetupResult> {
    return this.serverManager.initializeProjectManual({
      projectName,
      parentPageId,
    });
  }
}
