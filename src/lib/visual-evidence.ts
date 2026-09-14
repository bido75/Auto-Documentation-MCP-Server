import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, dirname } from "node:path";
import { resolveArtifactPath } from "./artifact-paths.js";

export interface VisualAnnotation {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

export interface VisualEvidence {
  visualId: string;
  projectId: string;
  artifactPath: string;
  mediaType: string;
  caption: string;
  altText?: string;
  evidenceEventId?: string;
  featureKey?: string;
  annotations?: VisualAnnotation[];
  annotatedArtifactPath?: string;
  createdAt: string;
}

export class VisualEvidenceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VisualEvidenceError";
  }
}

function mediaTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return "image/png";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function ensureReadableFile(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) {
    throw new VisualEvidenceError("VISUAL_EVIDENCE_NOT_FILE", "Visual evidence source must be a readable file.");
  }
}

export async function attachVisualEvidence(input: {
  projectId: string;
  caption: string;
  sourcePath?: string;
  imageBase64?: string;
  outputPath?: string;
  altText?: string;
  evidenceEventId?: string;
  featureKey?: string;
}): Promise<VisualEvidence> {
  if (!input.sourcePath && !input.imageBase64) {
    throw new VisualEvidenceError(
      "VISUAL_EVIDENCE_SOURCE_REQUIRED",
      "Visual evidence requires a provided artifact path or imageBase64 payload.",
    );
  }

  const fallbackName = `visuals/${randomUUID()}.png`;
  const requestedOutputPath = input.outputPath ?? (input.sourcePath ? `visuals/${randomUUID()}${extname(input.sourcePath) || ".png"}` : fallbackName);
  const safeOutputPath = resolveArtifactPath(requestedOutputPath);
  await mkdir(dirname(safeOutputPath), { recursive: true });

  if (input.imageBase64) {
    await writeFile(safeOutputPath, Buffer.from(input.imageBase64, "base64"));
  } else if (input.sourcePath) {
    const safeSourcePath = resolveArtifactPath(input.sourcePath);
    await ensureReadableFile(safeSourcePath);
    await copyFile(safeSourcePath, safeOutputPath);
  }

  await ensureReadableFile(safeOutputPath);

  return {
    visualId: `vis_${randomUUID()}`,
    projectId: input.projectId,
    artifactPath: safeOutputPath,
    mediaType: mediaTypeForPath(safeOutputPath),
    caption: input.caption,
    altText: input.altText,
    evidenceEventId: input.evidenceEventId,
    featureKey: input.featureKey,
    createdAt: new Date().toISOString(),
  };
}

function parseSvgDimensions(svg: string): { width: number; height: number } {
  const width = svg.match(/\bwidth=["'](\d+(?:\.\d+)?)["']/i)?.[1];
  const height = svg.match(/\bheight=["'](\d+(?:\.\d+)?)["']/i)?.[1];
  if (width && height) {
    return { width: Number(width), height: Number(height) };
  }

  const viewBox = svg.match(/\bviewBox=["'][^"']*\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)["']/i);
  if (viewBox) {
    return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  }

  throw new VisualEvidenceError("VISUAL_DIMENSIONS_UNREADABLE", "SVG dimensions are required for deterministic annotations.");
}

function validateAnnotations(annotations: VisualAnnotation[], dimensions: { width: number; height: number }) {
  for (const annotation of annotations) {
    if (
      annotation.x < 0 ||
      annotation.y < 0 ||
      annotation.width <= 0 ||
      annotation.height <= 0 ||
      annotation.x + annotation.width > dimensions.width ||
      annotation.y + annotation.height > dimensions.height
    ) {
      throw new VisualEvidenceError("VISUAL_ANNOTATION_OUT_OF_BOUNDS", "Annotation coordinates must stay within image bounds.");
    }
  }
}

function renderAnnotation(annotation: VisualAnnotation, index: number): string {
  const color = annotation.color ?? "#f97316";
  const labelY = Math.max(16, annotation.y - 8);
  return [
    `<g data-auto-doc-annotation="${index + 1}">`,
    `<rect x="${annotation.x}" y="${annotation.y}" width="${annotation.width}" height="${annotation.height}" fill="none" stroke="${escapeXml(color)}" stroke-width="3"/>`,
    `<rect x="${annotation.x}" y="${labelY - 14}" width="${Math.max(88, annotation.label.length * 7 + 18)}" height="20" fill="${escapeXml(color)}"/>`,
    `<text x="${annotation.x + 8}" y="${labelY}" fill="#111827" font-size="12" font-family="Arial, sans-serif">${escapeXml(annotation.label)}</text>`,
    "</g>",
  ].join("");
}

export async function annotateVisualEvidence(input: {
  sourcePath: string;
  outputPath: string;
  annotations: VisualAnnotation[];
}): Promise<{ artifactPath: string; mediaType: string; annotations: VisualAnnotation[] }> {
  const safeSourcePath = resolveArtifactPath(input.sourcePath);
  const safeOutputPath = resolveArtifactPath(input.outputPath);
  await ensureReadableFile(safeSourcePath);
  const source = await readFile(safeSourcePath, "utf8");
  const dimensions = parseSvgDimensions(source);
  validateAnnotations(input.annotations, dimensions);
  const overlay = input.annotations.map(renderAnnotation).join("");
  const annotated = source.replace(/<\/svg>\s*$/i, `${overlay}</svg>`);
  if (annotated === source) {
    throw new VisualEvidenceError("VISUAL_ANNOTATION_UNSUPPORTED_FORMAT", "Only SVG annotation is supported without raster synthesis.");
  }

  await mkdir(dirname(safeOutputPath), { recursive: true });
  await writeFile(safeOutputPath, annotated, "utf8");
  return { artifactPath: safeOutputPath, mediaType: "image/svg+xml", annotations: input.annotations };
}

export function createIllustrativeDiagramFallback(input: { title: string; description: string }): {
  kind: "illustration";
  isScreenshot: false;
  caption: string;
  svg: string;
} {
  const marker = "Illustrative diagram, not a screenshot";
  const title = escapeXml(input.title);
  const description = escapeXml(input.description);
  return {
    kind: "illustration",
    isScreenshot: false,
    caption: `${marker}: ${input.title}`,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" role="img" aria-label="${escapeXml(marker)}"><rect width="960" height="540" fill="#f8fafc"/><text x="48" y="72" font-size="28" font-family="Arial, sans-serif" fill="#111827">${escapeXml(marker)}</text><text x="48" y="136" font-size="38" font-family="Arial, sans-serif" fill="#111827">${title}</text><text x="48" y="196" font-size="22" font-family="Arial, sans-serif" fill="#374151">${description}</text></svg>`,
  };
}
