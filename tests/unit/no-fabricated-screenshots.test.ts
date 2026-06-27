/**
 * Acceptance: Visual feature criterion 5 - NO FABRICATION (the central safety guard)
 * No code path produces an image depicting the REAL UI without a provided artifact or live capture.
 * Diagram fallback output MUST carry a visible "illustrative, not a screenshot" marker.
 * This is the anti-mockup guard - the whole feature's integrity rests on it. DO NOT DELETE/SKIP.
 */
import { describe, expect, it } from "vitest";

describe("no-fabricated-screenshots", () => {
  it("no runtime path generates a product-UI screenshot without a provided artifact OR a live capture", async () => {
    const { attachVisualEvidence } = await import("../../src/lib/visual-evidence.js");

    await expect(
      attachVisualEvidence({
        projectId: "project_1",
        caption: "Missing visual source",
      }),
    ).rejects.toMatchObject({ code: "VISUAL_EVIDENCE_SOURCE_REQUIRED" });
  });

  it("diagram-fallback output is always labeled as an illustrative diagram (visible caption marker)", async () => {
    const { createIllustrativeDiagramFallback } = await import("../../src/lib/visual-evidence.js");

    const diagram = createIllustrativeDiagramFallback({
      title: "Billing export workflow",
      description: "Open Billing Settings and click Export.",
    });

    expect(diagram.svg).toContain("Illustrative diagram, not a screenshot");
    expect(diagram.caption).toContain("Illustrative diagram, not a screenshot");
  });

  it("the diagram fallback is never inserted silently as if it were a real capture", async () => {
    const { createIllustrativeDiagramFallback } = await import("../../src/lib/visual-evidence.js");

    expect(createIllustrativeDiagramFallback({ title: "Billing", description: "Export" })).toMatchObject({
      kind: "illustration",
      isScreenshot: false,
    });
  });

  it('guard: no image-generation API is wired to the "screenshot of feature" path', async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/lib/visual-evidence.ts", "utf8");

    expect(source).not.toMatch(/images\.generate|dall-e|gpt-image|image_generation|createImage/i);
  });
});
