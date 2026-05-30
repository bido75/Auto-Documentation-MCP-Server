import type { Audience, DocumentationStatus } from "../types.js";

interface ManualEntry {
  title: string;
  body: string;
  audience: Audience;
  status: DocumentationStatus;
}

function isPublishableStatus(status: DocumentationStatus): boolean {
  return status === "Published" || status === "Approved";
}

function buildSection(title: string, entries: ManualEntry[]): string[] {
  if (entries.length === 0) {
    return [`## ${title}`, "", "No entries available.", ""];
  }

  return [
    `## ${title}`,
    "",
    ...entries.flatMap((entry) => [`### ${entry.title}`, "", entry.body, ""]),
  ];
}

export function buildMarkdownManual(input: {
  projectName: string;
  releaseVersion: string;
  audience: "User" | "Admin" | "Both";
  entries: ManualEntry[];
}) {
  const userEntries = input.entries.filter(
    (entry) =>
      isPublishableStatus(entry.status) &&
      (input.audience === "Both" || input.audience === "User") &&
      (entry.audience === "User" || entry.audience === "Both"),
  );

  const adminEntries = input.entries.filter(
    (entry) =>
      isPublishableStatus(entry.status) &&
      (input.audience === "Both" || input.audience === "Admin") &&
      (entry.audience === "Admin" || entry.audience === "Both"),
  );

  const whatsNewEntries = input.entries.filter((entry) => isPublishableStatus(entry.status));

  return [
    `# ${input.projectName} - ${input.releaseVersion} Manual`,
    "",
    ...buildSection("User Guide", userEntries),
    ...buildSection("Admin Guide", adminEntries),
    `## What's New in ${input.releaseVersion}`,
    "",
    ...(whatsNewEntries.length > 0
      ? whatsNewEntries.flatMap((entry) => [`- ${entry.title}`])
      : ["No published updates."]),
    "",
  ].join("\n");
}
