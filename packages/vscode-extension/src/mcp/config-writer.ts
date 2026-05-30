import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type McpWriteTarget = {
  name: "cursor" | "windsurf" | "workspace";
  filePath: string;
};

export function resolveMcpTargets(workspacePath: string | undefined): McpWriteTarget[] {
  const targets: McpWriteTarget[] = [
    {
      name: "cursor",
      filePath: path.join(os.homedir(), ".cursor", "mcp.json"),
    },
    {
      name: "windsurf",
      filePath: path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"),
    },
  ];

  if (workspacePath && workspacePath.trim().length > 0) {
    targets.push({
      name: "workspace",
      filePath: path.join(workspacePath, ".mcp.json"),
    });
  }

  return targets;
}

export async function writeMcpConfig(
  targetPath: string,
  serverPath: string,
  _notionToken: string,
): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(targetPath, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }

  const existingServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};

  const merged = {
    ...existing,
    mcpServers: {
      ...existingServers,
      "auto-doc-mcp": {
        command: "node",
        args: [serverPath],
        env: {
          NOTION_TOKEN: "__NOTION_TOKEN__",
        },
      },
    },
  };

  await fs.writeFile(targetPath, JSON.stringify(merged, null, 2), "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
