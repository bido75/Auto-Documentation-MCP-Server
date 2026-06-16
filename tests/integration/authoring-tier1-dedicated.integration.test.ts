import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const authoringProvider = vi.hoisted(() => ({
  calls: 0,
  fail: false,
  body:
    "## Overview\nTier 1 dedicated prose explains the billing export in original words.\n\n## Prerequisites\n- Billing Reader access\n- The Auto-Doc MCP server command\n\n## Step-by-step setup\n1. Open Settings > Billing.\n2. Choose Export invoices.\n3. Save the generated CSV.\n\nExpected result: the CSV downloads for the selected billing period.\n\n## Troubleshooting\n- Ask an administrator for Billing Reader access if Export is hidden.",
}));

vi.mock("../../src/providers/factory.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/providers/factory.js")>("../../src/providers/factory.js");
  return {
    ...actual,
    authorManualWithFallback: vi.fn(async () => {
      authoringProvider.calls += 1;
      if (authoringProvider.fail) throw new Error("dedicated authoring unavailable");
      return { body: authoringProvider.body, providerUsed: "test-author-provider", generationMs: 2 };
    }),
  };
});

async function createRepoFixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-tier1-"));
  await writeFile(join(repoPath, "README.md"), "# Auto-Doc\nSource context should not be copied.\n");
  await writeFile(join(repoPath, "package.json"), JSON.stringify({ scripts: { start: "node build/src/index.js" } }));
  await writeFile(join(repoPath, ".env.example"), "NOTION_TOKEN=\nSTATE_ENCRYPTION_KEY=\n");
  return repoPath;
}

const previousEnabled = process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;

afterEach(() => {
  authoringProvider.calls = 0;
  authoringProvider.fail = false;
  vi.clearAllMocks();
  if (previousEnabled === undefined) delete process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED;
  else process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = previousEnabled;
});

describe("authoring-tier1-dedicated", () => {
  it("uses dedicated Tier-1 provider prose instead of analyzer narrative or template", async () => {
    process.env.AUTO_DOC_DEDICATED_AUTHORING_ENABLED = "true";
    const { authorManualSection } = await import("../../src/lib/manual-author.js");
    const section = await authorManualSection({
      audience: "User",
      entryType: "User Guide",
      featureName: "Billing Export",
      summary: "Template summary should not win.",
      diffSummary: "Repo evidence excerpt:\nGET POST MCP HTTP",
      filesChanged: ["README.md"],
      repoPath: await createRepoFixture(),
      providerNarrative: {
        providerUsed: "analyzer-provider",
        userGuide: {
          summary: "Tier 2 analyzer narrative should not win.",
          steps: ["Analyzer step"],
          expectedOutcome: "Analyzer outcome.",
          possibleErrors: [],
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

    expect(authoringProvider.calls).toBe(1);
    expect(section.authoringTier).toBe("tier1-dedicated");
    expect(section.providerUsed).toBe("test-author-provider");
    expect(section.body).toContain("Tier 1 dedicated prose");
    expect(section.body).toContain("## Prerequisites");
    expect(section.body).toContain("1. Open Settings > Billing.");
    expect(section.body).toContain("Expected result:");
    expect(section.body).not.toContain("Tier 2 analyzer narrative");
    expect(section.body).not.toContain("Source context:");
    expect(section.body).not.toMatch(/\bGET POST MCP HTTP\b/);
  });
});
