import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/providers/factory.js", () => ({
  analyzeWithFallback: vi.fn(async () => ({
    featureName: "Billing Export",
    featureKey: "provider:billing-export",
    shouldDocument: true,
    audiences: ["User"],
    userGuide: {
      summary: "Users can export invoices from the billing settings page.",
      steps: ["Open billing settings", "Select export invoices", "Download the generated file"],
      expectedOutcome: "The invoice export downloads successfully.",
      possibleErrors: ["Check billing permissions if export is unavailable"],
    },
    adminGuide: {
      configRequired: ["No new configuration required"],
      endpointsAffected: [],
      envVarsRequired: [],
      verificationSteps: ["Confirm the export button appears for billing users"],
      troubleshooting: [],
    },
    confidenceScore: 82,
    confidenceReasons: ["Provider identified a user-facing billing workflow."],
    reviewQuestions: [],
    providerUsed: "test-provider",
    generationMs: 1,
  })),
}));

describe("provider-backed analyzer surface", () => {
  it("imports and analyzes captured evidence without broken export drift", async () => {
    const { analyzeDocumentationCandidate } = await import("../../src/lib/analyzer.js");

    const result = await analyzeDocumentationCandidate({
      projectId: "project_1",
      evidence: [
        {
          summary: "Added billing settings page with invoice export workflow",
          diffSummary: "Added /billing/settings export button",
          filesChanged: ["src/routes/billing/settings.tsx"],
          eventType: "commit",
          source: "local_git",
          testStatus: "passed",
          branch: "feature/billing-export",
        },
      ],
      existingFeatureKeys: [],
    });

    expect(result.shouldDocument).toBe(true);
    expect(result.featureKey).toBe("route:billing-settings");
    expect(result.featureName).toBe("Billing Export");
    expect(result.confidenceReasons.join(" ")).toContain("Provider used: test-provider");
  });
});
