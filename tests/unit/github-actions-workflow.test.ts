import { describe, expect, it } from "vitest";
import { generateWorkflowContent } from "../../src/cli/commands/init-github-actions.js";

describe("GitHub Actions workflow generation", () => {
  it("generates a bridge-authenticated workflow without embedding secrets", () => {
    const workflow = generateWorkflowContent({
      serverUrl: "https://mcp.example.com",
      projectId: "project_123",
      defaultBranch: "trunk",
    });

    expect(workflow).toContain("branches: [trunk, master]");
    expect(workflow).toContain("project_123");
    expect(workflow).toContain("secrets.AUTO_DOC_MCP_URL");
    expect(workflow).toContain("secrets.AUTO_DOC_BRIDGE_API_KEY");
    expect(workflow).toContain("X-Auto-Doc-Bridge-Key");
    expect(workflow).not.toContain("replace-with");
    expect(workflow).not.toContain("ntn_");
    expect(workflow).not.toContain("sk-");
  });
});
