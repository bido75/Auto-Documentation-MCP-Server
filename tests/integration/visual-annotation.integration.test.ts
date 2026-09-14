/**
 * Acceptance: Visual feature criterion 2 - real annotation (deterministic compositing on a REAL image)
 * Annotation draws labeled overlays on a real image; it does NOT generate a new scene.
 * DO NOT DELETE/SKIP.
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const sourceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#ffffff"/><rect x="20" y="20" width="80" height="40" fill="#dddddd"/></svg>`;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

beforeEach(() => {
  delete process.env.AUTO_DOC_ARTIFACT_ROOT;
});

describe("visual-annotation", () => {
  it("given a real input image + label instructions, annotated output file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-doc-annotation-"));
    process.env.AUTO_DOC_ARTIFACT_ROOT = root;
    await writeFile(join(root, "input.svg"), sourceSvg, "utf8");
    const { annotateVisualEvidence } = await import("../../src/lib/visual-evidence.js");

    const result = await annotateVisualEvidence({
      sourcePath: "input.svg",
      outputPath: "annotated.svg",
      annotations: [{ label: "Export button", x: 20, y: 20, width: 80, height: 40 }],
    });

    expect(await exists(result.artifactPath)).toBe(true);
  });

  it("annotated output DIFFERS from the original (overlays were actually drawn)", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-doc-annotation-"));
    process.env.AUTO_DOC_ARTIFACT_ROOT = root;
    await writeFile(join(root, "input.svg"), sourceSvg, "utf8");
    const { annotateVisualEvidence } = await import("../../src/lib/visual-evidence.js");

    const result = await annotateVisualEvidence({
      sourcePath: "input.svg",
      outputPath: "annotated.svg",
      annotations: [{ label: "Export button", x: 20, y: 20, width: 80, height: 40 }],
    });

    expect(await readFile(result.artifactPath, "utf8")).not.toBe(await readFile(join(root, "input.svg"), "utf8"));
    expect(await readFile(result.artifactPath, "utf8")).toContain("Export button");
  });

  it("the original image is preserved unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-doc-annotation-"));
    process.env.AUTO_DOC_ARTIFACT_ROOT = root;
    const inputPath = join(root, "input.svg");
    await writeFile(inputPath, sourceSvg, "utf8");
    const { annotateVisualEvidence } = await import("../../src/lib/visual-evidence.js");

    await annotateVisualEvidence({
      sourcePath: "input.svg",
      outputPath: "annotated.svg",
      annotations: [{ label: "Export button", x: 20, y: 20, width: 80, height: 40 }],
    });

    expect(await readFile(inputPath, "utf8")).toBe(sourceSvg);
  });

  it("annotation coords outside image bounds return a typed error (no broken figure written)", async () => {
    const root = await mkdtemp(join(tmpdir(), "auto-doc-annotation-"));
    process.env.AUTO_DOC_ARTIFACT_ROOT = root;
    await writeFile(join(root, "input.svg"), sourceSvg, "utf8");
    const { annotateVisualEvidence } = await import("../../src/lib/visual-evidence.js");

    await expect(
      annotateVisualEvidence({
        sourcePath: "input.svg",
        outputPath: "annotated.svg",
        annotations: [{ label: "Off canvas", x: 220, y: 20, width: 80, height: 40 }],
      }),
    ).rejects.toMatchObject({ code: "VISUAL_ANNOTATION_OUT_OF_BOUNDS" });
    expect(await exists(join(root, "annotated.svg"))).toBe(false);
  });

  it("annotation does not invoke any image-generation/synthesis path", async () => {
    const { readFile: readSource } = await import("node:fs/promises");
    const source = await readSource("src/lib/visual-evidence.ts", "utf8");
    expect(source).not.toMatch(/images\.generate|dall-e|gpt-image|image_generation/i);
  });
});
