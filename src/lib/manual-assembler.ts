import { divider, heading1, heading2, paragraph } from "./notion-blocks.js";
import { redactSecrets } from "./redaction.js";
import type { ManualFigure } from "../types.js";

export type AssembledManualAudience = "user" | "admin";

export interface ManualAssemblyEntry {
  id: string;
  title: string;
  audience: "User" | "Admin" | "Both" | "Internal";
  status: "Captured" | "Needs Review" | "Approved" | "Published" | "Deprecated";
  entryType?: string;
  body: string;
  figures?: ManualFigure[];
}

export interface AssembledManualDocument {
  audience: AssembledManualAudience;
  title: "User Manual" | "Admin Manual";
  blocks: ReturnType<typeof heading1 | typeof heading2 | typeof paragraph | typeof divider>[];
  markdown: string;
  entryCount: number;
  sectionCount: number;
}

export class EmptyManualOutputError extends Error {
  readonly code = "EMPTY_MANUAL_OUTPUT";

  constructor(message: string) {
    super(message);
    this.name = "EmptyManualOutputError";
  }
}

function audienceMatches(entry: ManualAssemblyEntry, audience: AssembledManualAudience): boolean {
  if (entry.status !== "Published" && entry.status !== "Approved") {
    return false;
  }
  if (entry.audience === "Internal") {
    return false;
  }
  if (entry.audience === "Both") {
    return true;
  }
  return audience === "user" ? entry.audience === "User" : entry.audience === "Admin";
}

function publishableEntryCount(entries: ManualAssemblyEntry[]): number {
  return entries.filter((entry) => (entry.status === "Published" || entry.status === "Approved") && entry.audience !== "Internal").length;
}

function figureMarkdown(figure: ManualFigure): string | null {
  const target = figure.url ?? figure.artifactPath;
  if (!target) {
    return null;
  }
  const altText = (figure.altText ?? figure.caption).replaceAll("]", "\\]");
  return [`![${altText}](${target})`, figure.caption.trim().length > 0 ? `_${figure.caption}_` : ""].filter(Boolean).join("\n");
}

type FeatureSection = {
  title: string;
  body: string;
};

const FEATURE_ORDER: Array<{ pattern: RegExp; rank: number }> = [
  { pattern: /core|pipeline/, rank: 10 },
  { pattern: /autonomous|orchestrator/, rank: 20 },
  { pattern: /runner|continuous/, rank: 30 },
  { pattern: /bridge|http|sse|auth/, rank: 40 },
  { pattern: /provider|analysis|ai|llm/, rank: 50 },
  { pattern: /export|sync|markdown|pdf|help/, rank: 60 },
  { pattern: /release|package|changelog/, rank: 70 },
  { pattern: /state|store|encryption/, rank: 80 },
  { pattern: /visual|screenshot|figure/, rank: 90 },
  { pattern: /vs code|vscode|extension|companion/, rank: 100 },
  { pattern: /docker|self-host|deploy/, rank: 110 },
];

function cleanFeatureTitle(entry: ManualAssemblyEntry): string {
  const heading = entry.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const raw = heading || entry.title;
  return raw
    .replace(/\s+(?:User|Admin|Developer|Release)\s+Guide$/i, "")
    .replace(/\s+Developer Note$/i, "")
    .replace(/\s+Release Note$/i, "")
    .trim();
}

function featureRank(title: string): number {
  const normalized = title.toLowerCase();
  return FEATURE_ORDER.find((item) => item.pattern.test(normalized))?.rank ?? 1000;
}

function sortFeatureEntries(entries: ManualAssemblyEntry[]): ManualAssemblyEntry[] {
  return [...entries].sort((left, right) => {
    const leftTitle = cleanFeatureTitle(left);
    const rightTitle = cleanFeatureTitle(right);
    const rankDelta = featureRank(leftTitle) - featureRank(rightTitle);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return leftTitle.localeCompare(rightTitle);
  });
}

function normalizeFeatureBody(entry: ManualAssemblyEntry, title: string): string {
  const lines = entry.body.split(/\r?\n/);
  const normalized: string[] = [];
  let skippedTitle = false;
  for (const rawLine of lines) {
    const titleMatch = /^#\s+(.+)$/.exec(rawLine.trim());
    if (!skippedTitle && titleMatch && titleMatch[1]?.trim() === title) {
      skippedTitle = true;
      continue;
    }
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(rawLine);
    if (headingMatch) {
      const level = Math.min((headingMatch[1]?.length ?? 1) + 1, 6);
      normalized.push(`${"#".repeat(level)} ${headingMatch[2]}`);
      continue;
    }
    normalized.push(rawLine.trimEnd());
  }

  for (const figure of entry.figures ?? []) {
    const rendered = figureMarkdown(figure);
    if (rendered) {
      normalized.push("", rendered);
    }
  }

  return redactSecrets(normalized.join("\n").replace(/\n{3,}/g, "\n\n").trim());
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createTableOfContents(features: FeatureSection[]): string {
  return features.map((feature, index) => `${index + 1}. [${feature.title}](#${slugify(feature.title)})`).join("\n");
}

function createGlobalIntro(projectName: string, title: "User Manual" | "Admin Manual", features: FeatureSection[]): string {
  const featureMap = features.map((feature) => `- ${feature.title}`).join("\n");
  return [
    `This ${title} organizes ${projectName} by feature, so each workflow can be read from start to finish without jumping between global sections.`,
    "Feature map:",
    featureMap,
  ].join("\n\n");
}

function composeFeatureSections(entries: ManualAssemblyEntry[]): FeatureSection[] {
  return sortFeatureEntries(entries).map((entry) => {
    const title = cleanFeatureTitle(entry);
    return {
      title,
      body: normalizeFeatureBody(entry, title),
    };
  });
}

export function composeManualDocument(input: {
  projectName: string;
  audience: AssembledManualAudience;
  entries: ManualAssemblyEntry[];
}): AssembledManualDocument {
  const title = input.audience === "user" ? "User Manual" : "Admin Manual";
  if (publishableEntryCount(input.entries) === 0) {
    throw new EmptyManualOutputError(
      `No publishable manual entries are available for ${input.projectName}. Refusing to emit a default-shell manual.`,
    );
  }
  const entries = input.entries.filter((entry) => audienceMatches(entry, input.audience));
  const features = composeFeatureSections(entries);

  const blocks: AssembledManualDocument["blocks"] = [
    heading1(title),
    paragraph(`${input.projectName} ${title}`),
    heading2("Table of contents"),
    paragraph(createTableOfContents(features)),
    heading2("Introduction"),
    paragraph(createGlobalIntro(input.projectName, title, features)),
  ];
  const markdownParts = [
    `# ${title}`,
    `${input.projectName} ${title}`,
    "## Table of contents",
    createTableOfContents(features),
    "## Introduction",
    createGlobalIntro(input.projectName, title, features),
  ];

  for (const feature of features) {
    blocks.push(heading2(feature.title));
    blocks.push(paragraph(feature.body));
    blocks.push(divider());
    markdownParts.push(`## ${feature.title}`, feature.body);
  }

  return {
    audience: input.audience,
    title,
    blocks,
    markdown: markdownParts.join("\n\n"),
    entryCount: entries.length,
    sectionCount: features.length,
  };
}

export function composeAssembledManualMarkdown(input: {
  projectName: string;
  audience: "user" | "admin" | "both";
  entries: ManualAssemblyEntry[];
  releaseVersion?: string;
}): string {
  const documents =
    input.audience === "both"
      ? [
          composeManualDocument({ projectName: input.projectName, audience: "user", entries: input.entries }),
          composeManualDocument({ projectName: input.projectName, audience: "admin", entries: input.entries }),
        ]
      : [composeManualDocument({ projectName: input.projectName, audience: input.audience, entries: input.entries })];

  const releaseLine = input.releaseVersion ? [`Release: ${input.releaseVersion}`, ""] : [];
  return [...releaseLine, ...documents.map((document) => document.markdown)].join("\n\n").trimEnd() + "\n";
}
