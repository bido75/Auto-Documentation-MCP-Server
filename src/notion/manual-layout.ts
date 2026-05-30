import type { EntryType } from "../types.js";
import {
  bulletedListItem,
  callout,
  codeBlock,
  divider,
  heading2,
  heading3,
  numberedListItem,
  paragraph,
  toggle,
} from "../lib/notion-blocks.js";

type NotionBlock = Record<string, unknown>;

type LayoutEntry = {
  title: string;
  entryType: EntryType | string;
  audience: "User" | "Admin" | "Both" | "Internal";
  body: string;
  status?: string;
  routes?: string[];
  apiEndpoints?: string[];
};

type Section = {
  label: string | null;
  content: string;
};

function normalizeLabel(label: string) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function splitBodySections(body: string): Section[] {
  return body
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^([^:\n]+):\n([\s\S]+)$/);
      if (!match) {
        return { label: null, content: part };
      }

      return {
        label: match[1].trim(),
        content: match[2].trim(),
      };
    });
}

function takeSection(sections: Section[], ...candidates: string[]) {
  const candidateSet = new Set(candidates.map(normalizeLabel));
  const index = sections.findIndex((section) => section.label && candidateSet.has(normalizeLabel(section.label)));
  if (index === -1) {
    return undefined;
  }

  const [section] = sections.splice(index, 1);
  return section.content;
}

function takePlainSections(sections: Section[]) {
  const plain = sections.filter((section) => !section.label).map((section) => section.content);
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    if (!sections[index].label) {
      sections.splice(index, 1);
    }
  }
  return plain;
}

function sentenceList(content: string): string[] {
  return content
    .split(/\n+/)
    .map((item) => item.replace(/^[\-*•\s]+/, "").trim())
    .filter(Boolean);
}

function trimLines(items: string[] | undefined) {
  return (items ?? []).map((item) => item.trim()).filter(Boolean);
}

function normalizePackagedBody(body: string): string {
  const droppedLineMatchers: RegExp[] = [
    /^Audience:\s/i,
    /^Entry Type:\s/i,
    /^Status:\s/i,
    /^User Manual & Guides$/i,
    /^Admin & Technical Specifications$/i,
    /^How to Use$/i,
    /^Routes \/ URLs$/i,
    /^API Endpoints$/i,
    /^Permissions & Integrations$/i,
    /^Operational Workflow$/i,
    /^How to verify$/i,
    /^Troubleshooting$/i,
  ];

  const seen = new Set<string>();
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !droppedLineMatchers.some((matcher) => matcher.test(line)))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  const normalized = lines.join("\n").trim();
  if (normalized.length <= 2200) {
    return normalized;
  }

  return `${normalized.slice(0, 2197)}...`;
}

function buildUserSection(entry: LayoutEntry, sections: Section[]): NotionBlock[] {
  const blocks: NotionBlock[] = [heading2("User Manual & Guides")];
  const quickSummary =
    takeSection(sections, "Quick Summary", "What users can do now", "Summary") ?? takePlainSections(sections)[0];

  if (quickSummary) {
    blocks.push(callout(quickSummary, "💡", "blue_background"));
  }

  const steps = [
    takeSection(sections, "Where to go"),
    takeSection(sections, "What action to take"),
    takeSection(sections, "Expected result"),
  ].filter((value): value is string => Boolean(value));

  if (steps.length > 0) {
    blocks.push(heading3("How to Use"));
    blocks.push(...steps.map((step) => numberedListItem(step)));
  }

  const errors = takeSection(sections, "Errors or edge states", "Errors", "Edge states");
  if (errors) {
    blocks.push(callout(errors, "⚠️", "yellow_background"));
  }

  const routes = trimLines(entry.routes);
  if (routes.length > 0) {
    blocks.push(heading3("Routes / URLs"));
    blocks.push(codeBlock(routes.join("\n"), "plain text"));
  }

  for (const section of sections) {
    if (section.label) {
      blocks.push(heading3(section.label));
    }
    blocks.push(paragraph(section.content));
  }

  return blocks;
}

function buildAdminSection(entry: LayoutEntry, sections: Section[]): NotionBlock[] {
  const blocks: NotionBlock[] = [heading2("Admin & Technical Specifications")];
  const adminNotice = takeSection(sections, "System Administrator Notice", "What must be configured");
  if (adminNotice) {
    blocks.push(callout(adminNotice, "⚠️", "yellow_background"));
  }

  const permissions = takeSection(sections, "Permissions and integrations");
  if (permissions) {
    blocks.push(heading3("Permissions & Integrations"));
    blocks.push(paragraph(permissions));
  }

  const workflow = takeSection(sections, "Operational workflow change", "How to verify");
  if (workflow) {
    blocks.push(heading3("Operational Workflow"));
    blocks.push(...sentenceList(workflow).map((line) => bulletedListItem(line)));
  }

  const apiEndpoints = trimLines(entry.apiEndpoints);
  if (apiEndpoints.length > 0) {
    blocks.push(heading3("API Endpoints"));
    blocks.push(codeBlock(apiEndpoints.join("\n"), "plain text"));
  }

  const routes = trimLines(entry.routes);
  if (routes.length > 0) {
    blocks.push(heading3("Routes / URLs"));
    blocks.push(codeBlock(routes.join("\n"), "plain text"));
  }

  const troubleshooting = takeSection(sections, "Troubleshooting");
  if (troubleshooting) {
    blocks.push(toggle("Troubleshooting", [paragraph(troubleshooting)]));
  }

  for (const section of sections) {
    if (section.label) {
      blocks.push(heading3(section.label));
    }
    blocks.push(paragraph(section.content));
  }

  return blocks;
}

function buildGenericSection(entry: LayoutEntry, sections: Section[]): NotionBlock[] {
  const blocks: NotionBlock[] = [heading2("Technical Details")];
  const plainSections = takePlainSections(sections);
  blocks.push(...plainSections.map((content) => paragraph(content)));

  for (const section of sections) {
    if (section.label) {
      blocks.push(heading3(section.label));
    }
    blocks.push(paragraph(section.content));
  }

  const apiEndpoints = trimLines(entry.apiEndpoints);
  if (apiEndpoints.length > 0) {
    blocks.push(heading3("API Endpoints"));
    blocks.push(codeBlock(apiEndpoints.join("\n"), "plain text"));
  }

  const routes = trimLines(entry.routes);
  if (routes.length > 0) {
    blocks.push(heading3("Routes / URLs"));
    blocks.push(codeBlock(routes.join("\n"), "plain text"));
  }

  return blocks;
}

function buildEntrySummary(entry: LayoutEntry) {
  const parts = [`Audience: ${entry.audience}`, `Entry Type: ${entry.entryType}`];
  if (entry.status) {
    parts.push(`Status: ${entry.status}`);
  }

  return parts.join(" | ");
}

export function buildManualEntryBlocks(entry: LayoutEntry): NotionBlock[] {
  const sections = splitBodySections(entry.body);
  const blocks: NotionBlock[] = [callout(buildEntrySummary(entry), "📘", "gray_background")];

  if (entry.entryType === "User Guide") {
    blocks.push(...buildUserSection(entry, sections));
  } else if (entry.entryType === "Admin Guide") {
    blocks.push(...buildAdminSection(entry, sections));
  } else {
    blocks.push(...buildGenericSection(entry, sections));
  }

  blocks.push(divider());
  return blocks;
}

function buildSectionBlocks(title: string, entries: LayoutEntry[]): NotionBlock[] {
  if (entries.length === 0) {
    return [heading2(title), paragraph("No entries available."), divider()];
  }

  const blocks: NotionBlock[] = [heading2(title)];
  for (const entry of entries) {
    const normalizedEntry: LayoutEntry = {
      ...entry,
      body: normalizePackagedBody(entry.body),
    };
    blocks.push(heading3(entry.title));
    blocks.push(...buildManualEntryBlocks(normalizedEntry).filter((block) => block.type !== "divider"));
    blocks.push(divider());
  }

  return blocks;
}

function summarizeForHistory(entry: LayoutEntry) {
  const sections = splitBodySections(entry.body);
  const first = sections[0]?.content ?? entry.body;
  return first.length > 240 ? `${first.slice(0, 237)}...` : first;
}

export function buildManualArtifactPageBlocks(input: {
  releaseVersion: string;
  audience: "user" | "admin" | "both";
  entries: LayoutEntry[];
}): NotionBlock[] {
  const publishable = (entry: LayoutEntry) => entry.status === "Published" || entry.status === "Approved";
  const userEntries = input.entries.filter(
    (entry) =>
      publishable(entry) &&
      (input.audience === "both" || input.audience === "user") &&
      (entry.audience === "User" || entry.audience === "Both"),
  );
  const adminEntries = input.entries.filter(
    (entry) =>
      publishable(entry) &&
      (input.audience === "both" || input.audience === "admin") &&
      (entry.audience === "Admin" || entry.audience === "Both"),
  );
  const versionEntries = input.entries.filter((entry) => publishable(entry));

  const overview = callout(
    `Release ${input.releaseVersion} | User entries: ${userEntries.length} | Admin entries: ${adminEntries.length} | Audience: ${input.audience}`,
    "📋",
    "gray_background",
  );

  const historyBlocks: NotionBlock[] = [heading2("Version & Changes History")];
  if (versionEntries.length === 0) {
    historyBlocks.push(paragraph("No published updates."));
  } else {
    for (const entry of versionEntries) {
      historyBlocks.push(
        toggle(`${entry.title} — ${entry.status ?? "Documented"}`, [paragraph(summarizeForHistory(entry))]),
      );
    }
  }

  return [
    overview,
    divider(),
    ...buildSectionBlocks("User Manual & Guides", userEntries),
    ...buildSectionBlocks("Admin & Technical Specifications", adminEntries),
    ...historyBlocks,
  ];
}