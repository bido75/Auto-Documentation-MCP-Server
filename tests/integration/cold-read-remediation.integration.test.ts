import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readWorkspaceFile(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("cold-read remediation", () => {
  it("ships an install-first quickstart that takes a new user from npx init to first documented event", () => {
    expect(existsSync(join(process.cwd(), "QUICKSTART.md"))).toBe(true);
    const quickstart = readWorkspaceFile("QUICKSTART.md");

    expect(quickstart).toContain("Node.js 18");
    expect(quickstart).toContain("Create a Notion integration");
    expect(quickstart).toContain("Share the page with the integration");
    expect(quickstart).toContain("npx auto-doc-mcp init");
    expect(quickstart).toContain('git commit -m "feat: add user authentication"');
    expect(quickstart).toContain("Within about 45 seconds");
    expect(quickstart).toContain("capture_development_event");
    expect(quickstart).toContain("analyze_documentation_candidate");
    expect(quickstart).toContain("upsert_feature_documentation");
    expect(quickstart).toContain("get_documentation_health");
    expect(quickstart).toContain("package_manual");
    expect(quickstart).toContain("export_manual_pdf");
    expect(quickstart).toContain("configure_webhook");
    expect(quickstart).toContain("probe_application");
    expect(quickstart).not.toContain('"jsonrpc": "2.0"');
  });

  it("keeps infrastructure setup in the linked self-hosting guide", () => {
    expect(existsSync(join(process.cwd(), "docs", "SELF-HOSTING.md"))).toBe(true);
    const selfHosting = readWorkspaceFile("docs/SELF-HOSTING.md");

    expect(selfHosting).toContain("Docker and Docker Compose");
    expect(selfHosting).toContain("NOTION_TOKEN");
    expect(selfHosting).toContain("STATE_ENCRYPTION_KEY");
    expect(selfHosting).toContain("AUTO_DOC_BRIDGE_API_KEY");
    expect(selfHosting).toContain("docker compose --profile self-hosted up -d --build");
    expect(selfHosting).toContain("curl http://localhost:3000/health");
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
