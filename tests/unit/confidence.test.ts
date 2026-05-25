import { describe, expect, it } from "vitest";
import { scoreDocumentationConfidence } from "../../src/analysis/confidence.js";

describe("scoreDocumentationConfidence", () => {
  it("scores merged PRs with tests and concrete docs as high confidence", () => {
    const result = scoreDocumentationConfidence({
      manualWorthy: true,
      featureNameMatched: true,
      testsPassed: true,
      mergedOrReleased: true,
      concreteDocumentation: true,
      ambiguousPurpose: false,
      duplicateUncertain: false,
    });

    expect(result.score).toBe(100);
    expect(result.reasons).toContain("Tests passed.");
  });

  it("penalizes ambiguity and uncertain duplicates", () => {
    const result = scoreDocumentationConfidence({
      manualWorthy: true,
      featureNameMatched: false,
      testsPassed: false,
      mergedOrReleased: false,
      concreteDocumentation: false,
      ambiguousPurpose: true,
      duplicateUncertain: true,
    });

    expect(result.score).toBe(5);
    expect(result.reviewQuestions.length).toBeGreaterThan(0);
  });
});
