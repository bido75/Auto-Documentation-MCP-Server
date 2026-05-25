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
  audience: "User" | "Admin" | "Both";
  entries: ManualEntry[];
}) {
  const included = input.entries.filter(
    (entry) => {
      const isEligibleStatus = entry.status === "Published" || entry.status === "Approved";
      if (!isEligibleStatus) {
        return false;
      }

      if (input.audience === "Both") {
        return entry.audience === "User" || entry.audience === "Admin" || entry.audience === "Both";
      }

      return entry.audience === input.audience || entry.audience === "Both";
    },
  );

  return [
    `# ${input.projectName} ${input.audience} Manual - ${input.releaseVersion}`,
    "",
    ...included.flatMap((entry) => [`## ${entry.title}`, "", entry.body, ""]),
  ].join("\n");
}
