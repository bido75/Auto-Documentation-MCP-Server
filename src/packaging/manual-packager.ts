import type { Audience, DocumentationStatus, ManualFigure } from "../types.js";

interface ManualEntry {
  title: string;
  body: string;
  audience: Audience;
  status: DocumentationStatus;
  figures?: ManualFigure[];
}

function figureMarkdown(figure: ManualFigure): string | null {
  const target = figure.url ?? figure.artifactPath;
  if (!target) {
    return null;
  }

  const altText = (figure.altText ?? figure.caption).replaceAll("]", "\\]");
  return [`![${altText}](${target})`, figure.caption.trim().length > 0 ? `_${figure.caption}_` : ""].filter(Boolean).join("\n");
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
    ...included.flatMap((entry) => [
      `## ${entry.title}`,
      "",
      entry.body,
      ...((entry.figures ?? []).map(figureMarkdown).filter((value): value is string => value !== null).flatMap((value) => ["", value])),
      "",
    ]),
  ].join("\n");
}
