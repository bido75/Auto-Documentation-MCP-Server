import type { Audience, DocumentationStatus } from "../types.js";

interface ManualEntry {
  title: string;
  body: string;
  audience: Audience;
  status: DocumentationStatus;
}

export function buildMarkdownManual(input: {
  projectName: string;
  releaseVersion: string;
  audience: "User" | "Admin";
  entries: ManualEntry[];
}) {
  const included = input.entries.filter(
    (entry) => entry.status === "Published" && (entry.audience === input.audience || entry.audience === "Both"),
  );

  return [
    `# ${input.projectName} ${input.audience} Manual - ${input.releaseVersion}`,
    "",
    ...included.flatMap((entry) => [`## ${entry.title}`, "", entry.body, ""]),
  ].join("\n");
}
