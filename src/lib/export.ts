import type { Audience, DocumentationStatus } from "../types.js";

interface ExportableEntry {
  title: string;
  entryType: string;
  audience: Audience;
  status: DocumentationStatus;
  body: string;
}

export function renderManualMarkdown(input: {
  projectName: string;
  audience: "user" | "admin" | "both";
  entries: ExportableEntry[];
}): string {
  const wanted =
    input.audience === "both"
      ? ["User", "Admin", "Both"]
      : input.audience === "user"
        ? ["User", "Both"]
        : ["Admin", "Both"];

  const included = input.entries.filter((entry) => entry.status === "Published" && wanted.includes(entry.audience));

  return [
    `# ${input.projectName} Manual Export`,
    "",
    ...included.flatMap((entry) => [`## ${entry.title}`, "", `Type: ${entry.entryType}`, "", entry.body, ""]),
  ].join("\n");
}
