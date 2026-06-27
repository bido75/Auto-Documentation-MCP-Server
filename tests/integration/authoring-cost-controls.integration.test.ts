import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const providerState = vi.hoisted(() => ({
  calls: 0,
  active: 0,
  maxActive: 0,
}));

vi.mock("../../src/providers/factory.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/providers/factory.js")>("../../src/providers/factory.js");
  return {
    ...actual,
    authorManualWithFallback: vi.fn(async () => {
      providerState.calls += 1;
      providerState.active += 1;
      providerState.maxActive = Math.max(providerState.maxActive, providerState.active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      providerState.active -= 1;
      return {
        body: "## Overview\nTier 1 body\n\n## Step-by-step setup\n1. Run the dedicated flow.\n\nExpected result: Tier 1 wins.",
        providerUsed: "test-author-provider",
        generationMs: 30,
      };
    }),
  };
});

async function createRepoFixture() {
  const repoPath = await mkdtemp(join(tmpdir(), "auto-doc-cost-"));
  await writeFile(join(repoPath, "README.md"), "# Auto-Doc\n");
  await writeFile(join(repoPath, "package.json"), JSON.stringify({ scripts: { start: "node build/src/index.js" } }));
  await writeFile(join(repoPath, ".env.example"), "NOTION_TOKEN=\nSTATE_ENCRYPTION_KEY=\n");
  return repoPath;
}

const envKeys = ["AUTO_DOC_DEDICATED_AUTHORING_ENABLED", "AUTO_DOC_AUTHORING_MAX_CONCURRENT"] as const;
const previousEnv = new Map<(typeof envKeys)[number], string | undefined>();

function setEnv(key: (typeof envKeys)[number], value: string): void {
  if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  providerState.calls = 0;
  providerState.active = 0;
  providerState.maxActive = 0;
  for (const key of envKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
});

const narrative = {
  providerUsed: "analyzer-provider",
  userGuide: {
    summary: "Tier 2 narrative body.",
    steps: ["Use the narrative flow."],
    expectedOutcome: "Tier 2 wins.",
    possibleErrors: [],
  },
  adminGuide: {
    configRequired: [],
    endpointsAffected: [],
    envVarsRequired: [],
    verificationSteps: [],
    troubleshooting: [],
  },
};

describe("authoring-cost-controls", () => {
  it("dedicated-call toggle on makes Tier 1 calls; toggle off uses Tier 2 without dedicated calls", async () => {
    const { authorManualSection } = await import("../../src/lib/manual-author.js");
    const repoPath = await createRepoFixture();

    setEnv("AUTO_DOC_DEDICATED_AUTHORING_ENABLED", "true");
    const tier1 = await authorManualSection({
      audience: "User",
      entryType: "User Guide",
      featureName: "Billing Export",
      summary: "summary",
      filesChanged: ["README.md"],
      repoPath,
      providerNarrative: narrative,
    });
    expect(tier1.authoringTier).toBe("tier1-dedicated");
    expect(providerState.calls).toBe(1);

    setEnv("AUTO_DOC_DEDICATED_AUTHORING_ENABLED", "false");
    const tier2 = await authorManualSection({
      audience: "User",
      entryType: "User Guide",
      featureName: "Billing Export",
      summary: "summary",
      filesChanged: ["README.md"],
      repoPath,
      providerNarrative: narrative,
    });
    expect(tier2.authoringTier).toBe("tier2-analyzer-narrative");
    expect(providerState.calls).toBe(1);
  });

  it("authoring provider concurrency cap is respected", async () => {
    setEnv("AUTO_DOC_DEDICATED_AUTHORING_ENABLED", "true");
    setEnv("AUTO_DOC_AUTHORING_MAX_CONCURRENT", "1");
    const { authorManualSection } = await import("../../src/lib/manual-author.js");
    const repoPath = await createRepoFixture();

    await Promise.all([
      authorManualSection({ audience: "User", entryType: "User Guide", featureName: "A", summary: "A", filesChanged: [], repoPath }),
      authorManualSection({ audience: "User", entryType: "User Guide", featureName: "B", summary: "B", filesChanged: [], repoPath }),
      authorManualSection({ audience: "Admin", entryType: "Admin Guide", featureName: "C", summary: "C", filesChanged: [], repoPath }),
    ]);

    expect(providerState.calls).toBe(3);
    expect(providerState.maxActive).toBe(1);
  });
});
