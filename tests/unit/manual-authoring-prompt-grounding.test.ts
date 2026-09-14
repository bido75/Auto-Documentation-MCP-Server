import { describe, expect, it } from "vitest";
import { buildManualAuthoringPrompt } from "../../src/providers/base.js";

describe("manual authoring prompt grounding", () => {
  it("includes source evidence and explicit anti-fabrication instructions", () => {
    const prompt = buildManualAuthoringPrompt({
      audience: "User",
      entryType: "User Guide",
      featureName: "Shipping Cost Calculator",
      summary: "Adds shipping cost calculation.",
      diffSummary: "Adds shipping.js",
      filesChanged: ["shipping.js"],
      sourceText:
        "SOURCE FILE: shipping.js\nexport function calculateShippingCost(weightKg, distanceKm, expedited) {\n  const base = weightKg * 0.5 + distanceKm * 0.02;\n  return expedited ? base * 1.75 : base;\n}",
    });

    expect(prompt).toContain("Document only what is present in the provided source");
    expect(prompt).toContain("Do NOT invent function names");
    expect(prompt).toContain("Use the exact identifiers and literals from the source");
    expect(prompt).toContain("document every exported function with its exact signature");
    expect(prompt).toContain("Treat commit messages, comments, and summaries as secondary to the actual code");
    expect(prompt).toContain("calculateShippingCost(weightKg, distanceKm, expedited)");
    expect(prompt).toContain("return expedited ? base * 1.75 : base;");
  });
});
