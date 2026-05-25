import { describe, expect, it } from "vitest";
import { collectGitEvidence } from "../../src/evidence/git.js";

describe("collectGitEvidence", () => {
  it("collects last commit evidence and redacts secrets", async () => {
    const evidence = await collectGitEvidence({
      repoPath: "/repo",
      mode: "last_commit",
      git: {
        branch: async () => ({ current: "feature/billing-export" }),
        show: async () => "commit abc123\nAdd invoice export\nNOTION_TOKEN=secret_abc",
        diff: async () => "",
        status: async () => ({ files: [{ path: "src/routes/billing.tsx" }] }),
      },
    });

    expect(evidence.branch).toBe("feature/billing-export");
    expect(evidence.summary).toContain("Add invoice export");
    expect(evidence.summary).toContain("NOTION_TOKEN=[REDACTED]");
    expect(evidence.filesChanged).toEqual(["src/routes/billing.tsx"]);
  });
});
