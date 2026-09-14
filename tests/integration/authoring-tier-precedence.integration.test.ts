import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const authoringProvider = vi.hoisted(() => ({
  fail: true,
  body: "## Overview\nDedicated body",
}));

vi.mock("../../src/providers/factory.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/providers/factory.js")>("../../src/providers/factory.js");
  return {
    ...actual,
    authorManualWithFallback: vi.fn(async () => {
      if (authoringProvider.fail) throw new Error("OPENROUTER_API_KEY=secret-tier dedicated failure");
      return { body: authoringProvider.body, providerUsed: "test-author-provider", generationMs: 1 };
    }),
  };
});

async function createRepoFixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-tiering-"));
  await writeFile(join(repoPath, "README.md"), "# Auto-Doc\n```bash\nnpm ci\n```\nGET POST MCP HTTP\n");
  await writeFile(join(repoPath, "package.json"), JSON.stringify({ scripts: { start: "node build/src/index.js", build: "tsc" } }));
  await writeFile(join(repoPath, ".env.example"), "NOTION_TOKEN=\nSTATE_ENCRYPTION_KEY=\nAUTO_DOC_HTTP_PORT=3000\n");
  return repoPath;
}

const previousEnabled = process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;

afterEach(() => {
  authoringProvider.fail = true;
  vi.restoreAllMocks();
  if (previousEnabled === undefined) delete process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;
  else process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = previousEnabled;
});

describe("authoring-tier-precedence", () => {
  it("dedicated failure falls back to Tier 2 analyzer narrative and logs the transition", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const section = await authorManualSection({
      audience: "User",
      entryType: "User Guide",
      featureName: "Billing Export",
      summary: "Template summary",
      filesChanged: ["README.md"],
      repoPath: await createRepoFixture(),
      providerNarrative: {
        providerUsed: "analyzer-provider",
        userGuide: {
          summary: "Tier 2 analyzer narrative reaches the user.",
          steps: ["Open Billing settings.", "Export invoices."],
          expectedOutcome: "Invoices download.",
          possibleErrors: ["Check billing access."],
        },
        adminGuide: {
          configRequired: [],
          endpointsAffected: [],
          envVarsRequired: [],
          verificationSteps: [],
          troubleshooting: [],
        },
      },
    });

    expect(section.authoringTier).toBe("tier2-analyzer-narrative");
    expect(section.body).toContain("Tier 2 analyzer narrative reaches the user.");
    const logs = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("authoring_tier_fallback");
    expect(logs).toContain("tier1-dedicated");
    expect(logs).toContain("tier2-analyzer-narrative");
    expect(logs).not.toContain("secret-tier");
  });

  it("no provider and no narrative falls back to clean Tier 3 template and logs the transition", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { authorManualSection } = await import("../../src/lib/manual-author.js");

    const section = await authorManualSection({
      audience: "Admin",
      entryType: "Admin Guide",
      featureName: "Deployment Configuration",
      summary: "Admin deployment docs.",
      diffSummary: "Repo evidence excerpt:\nGET POST MCP HTTP RPC",
      filesChanged: ["README.md", ".env.example"],
      repoPath: await createRepoFixture(),
    });

    expect(section.authoringTier).toBe("tier3-template");
    expect(section.body).toContain("NOTION_TOKEN:");
    expect(section.body).toContain("node build/src/index.js");
    expect(section.body).not.toContain("Source context:");
    expect(section.body).not.toContain("bash\nnpm ci");
    expect(section.body).not.toMatch(/^- (GET|POST|MCP|HTTP|RPC)$/m);
    const logs = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logs).toContain("tier3-template");
  });
});
