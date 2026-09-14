import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readWorkspaceFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("cold-read remediation", () => {
  it("ships a human-authored quickstart that takes a new user from clone to first documented event", () => {
    expect(existsSync(join(process.cwd(), "QUICKSTART.md"))).toBe(true);
    const quickstart = readWorkspaceFile("QUICKSTART.md");

    expect(quickstart).toContain("Node.js 20");
    expect(quickstart).toContain("Create a Notion integration");
    expect(quickstart).toContain("Share the page with the integration");
    expect(quickstart).toContain("NOTION_PARENT_PAGE_ID");
    expect(quickstart).toContain("STATE_ENCRYPTION_KEY");
    expect(quickstart).toContain("POSTGRES_PASSWORD");
    expect(quickstart).toContain("AI_PROVIDER_TYPE=local-ollama");
    expect(quickstart).toContain("AI_ENDPOINT=http://ollama:11434");
    expect(quickstart).toContain("AI_MODEL_NAME=llama3.1:8b-instruct-q4_K_M");
    expect(quickstart).toContain("OPENROUTER_API_KEY=");
    expect(quickstart).toContain("docker compose --profile self-hosted up -d --build");
    expect(quickstart).toContain("curl http://localhost:3000/health");
    expect(quickstart).toContain("initialize_project_manual");
    expect(quickstart).toContain("capture_development_event");
    expect(quickstart).toContain("analyze_documentation_candidate");
    expect(quickstart).toContain("upsert_feature_documentation");
    expect(quickstart).toContain("publish_or_queue_review");
    expect(quickstart).toContain("package_manual");
    expect(quickstart).toContain('"jsonrpc": "2.0"');
  });

  it("does not ship internal Langflow endpoints, embedded keys, or unobtainable Langflow requirements in user-facing config", () => {
    const checkedFiles = ["README.md", ".env.example", ".mcp.json", ".vscode/mcp.json"];
    for (const file of checkedFiles) {
      const text = readWorkspaceFile(file);
      expect(text, file).not.toContain("langflow.giscop.com");
      expect(text, file).not.toContain("2443b71b-51be-4fc3-9785-1ad162e8fb0a");
      expect(text, file).not.toContain("YOUR_LANGFLOW_API_KEY");
      expect(text, file).not.toMatch(/sk-[A-Za-z0-9_-]{20,}/);
    }
  });
});
