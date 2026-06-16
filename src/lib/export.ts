import type { Audience, DocumentationStatus, ManualFigure } from "../types.js";

interface ExportableEntry {
  title: string;
  entryType: string;
  audience: Audience;
  status: DocumentationStatus;
  body: string;
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
    ...included.flatMap((entry) => [
      `## ${entry.title}`,
      "",
      `Type: ${entry.entryType}`,
      "",
      entry.body,
      ...((entry.figures ?? []).map(figureMarkdown).filter((value): value is string => value !== null).flatMap((value) => ["", value])),
      "",
    ]),
  ].join("\n");
}
