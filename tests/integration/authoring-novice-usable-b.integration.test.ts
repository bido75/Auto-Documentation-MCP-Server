import { afterEach, describe, expect, it, vi } from "vitest";
import { composeManualDocument } from "../../src/lib/manual-assembler.js";

vi.mock("../../src/providers/factory.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/providers/factory.js")>("../../src/providers/factory.js");
  return {
    ...actual,
    authorManualWithFallback: vi.fn(async (input: { audience: string }) => ({
      body:
        input.audience === "Admin"
          ? "## Overview\nOperate Auto-Doc in production.\n\n## Prerequisites\n- Set NOTION_TOKEN.\n- Set STATE_ENCRYPTION_KEY.\n\n## Operations setup\n1. Run `npm run build`.\n2. Start `node build/src/cli/index.js bridge`.\n3. Check `GET /health`.\n\nExpected result: health returns OK and runner jobs can be triggered.\n\n## Troubleshooting\n- Inspect runner failure triage when jobs stop."
          : "## Overview\nUse Auto-Doc from an MCP client.\n\n## Prerequisites\n- MCP client access.\n- Project id from an administrator.\n\n## How to use it\n1. Open your MCP client settings.\n2. Add `node build/src/index.js` as the server command.\n3. Run `initialize_project_manual`.\n4. Export the manual after entries are published.\n\nExpected result: documentation appears in Notion and can be exported.",
      providerUsed: "test-author-provider",
      generationMs: 4,
    })),
  };
});

const previousEnabled = process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;

afterEach(() => {
  vi.restoreAllMocks();
  if (previousEnabled === undefined) delete process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;
  else process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = previousEnabled;
});

describe("authoring-novice-usable-b", () => {
  it("Tier-1 User and Admin content is novice-usable, original, and materially different", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const user = await authorManualSection({ audience: "User", entryType: "User Guide", featureName: "Use Auto-Doc", summary: "User docs", filesChanged: [] });
    const admin = await authorManualSection({ audience: "Admin", entryType: "Admin Guide", featureName: "Operate Auto-Doc", summary: "Admin docs", filesChanged: [] });

    expect(user.authoringTier).toBe("tier1-dedicated");
    expect(admin.authoringTier).toBe("tier1-dedicated");
    expect(user.body).toContain("## How to use it");
    expect(user.body).toContain("node build/src/index.js");
    expect(admin.body).toContain("## Prerequisites");
    expect(admin.body).toContain("STATE_ENCRYPTION_KEY");
    expect(admin.body).toContain("node build/src/cli/index.js bridge");
    expect(admin.body).toContain("GET /health");
    expect(user.body).not.toBe(admin.body);
    expect(`${user.body}\n${admin.body}`).not.toContain("Source context:");
    expect(`${user.body}\n${admin.body}`).not.toContain("Production-ready TypeScript MCP server that captures development signals");

    const manual = composeManualDocument({
      projectName: "Auto-Doc",
      audience: "admin",
      entries: [{ id: "admin", title: "Operate Auto-Doc", audience: "Admin", status: "Published", body: admin.body }],
    });
    expect(manual.markdown).toContain("## Operate Auto-Doc");
    expect(manual.markdown).toContain("### Operations setup");
    expect(manual.markdown).toContain("STATE_ENCRYPTION_KEY");
  });
});
