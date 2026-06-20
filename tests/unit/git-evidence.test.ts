import { describe, expect, it } from "vitest";
import { collectGitEvidence } from "../../src/evidence/git.js";

describe("collectGitEvidence", () => {
  it("collects last commit evidence and redacts secrets", async () => {
    const evidence = await collectGitEvidence({
      repoPath: "/repo",
      mode: "last_commit",
      git: {
        branch: async () => ({ current: "feature/billing-export" }),
        revparse: async () => "abc123",
        show: async (args?: string[]) => {
          if (args?.includes("--name-only")) {
            return "shipping.js\nsrc/routes/billing.tsx\n";
          }
          if (args?.includes("--patch")) {
            return "+export function calculateShippingCost(weightKg, distanceKm, expedited) {\n+  const base = weightKg * 0.5 + distanceKm * 0.02;\n+  return expedited ? base * 1.75 : base;\n+}\n+NOTION_TOKEN=secret_abc";
          }
          return "commit abc123\nAdd invoice export\nNOTION_TOKEN=secret_abc";
        },
        diff: async () => "",
        status: async () => ({ files: [{ path: "src/routes/billing.tsx" }] }),
      },
    });

    expect(evidence.branch).toBe("feature/billing-export");
    expect(evidence.commitSha).toBe("abc123");
    expect(evidence.summary).toContain("Add invoice export");
    expect(evidence.summary).toContain("NOTION_TOKEN=[REDACTED]");
    expect(evidence.filesChanged).toEqual(["shipping.js", "src/routes/billing.tsx"]);
    expect(evidence.diffSummary).toContain("calculateShippingCost(weightKg, distanceKm, expedited)");
    expect(evidence.diffSummary).toContain("NOTION_TOKEN=[REDACTED]");
  });
});
