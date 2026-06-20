import type { ManualFigure } from "../types.js";

type RichTextPart = { plain_text?: string; text?: { content?: string } };
type ManualContentBlock = {
  type?: string;
  heading_1?: { rich_text?: RichTextPart[] };
  heading_2?: { rich_text?: RichTextPart[] };
  heading_3?: { rich_text?: RichTextPart[] };
  paragraph?: { rich_text?: RichTextPart[] };
  bulleted_list_item?: { rich_text?: RichTextPart[] };
  numbered_list_item?: { rich_text?: RichTextPart[] };
  code?: { rich_text?: RichTextPart[]; language?: string };
  image?: {
    type?: "external" | "file";
    external?: { url?: string };
    file?: { url?: string };
    caption?: RichTextPart[];
  };
};

function richTextToPlainText(parts: RichTextPart[] | undefined): string {
  return (parts ?? [])
    .map((part) => part.plain_text ?? part.text?.content ?? "")
    .join("")
    .replace(/\u0000/g, "")
    .trim();
}

function removeDanglingLabels(input: string): string {
  const lines = input.split(/\r?\n/);
  const kept: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^(?:Parameters?|Returns?):\s*$/i.test(line.trim())) {
      kept.push(line);
      continue;
    }

    const nextMeaningful = lines.slice(index + 1).find((candidate) => candidate.trim().length > 0)?.trim() ?? "";
    const nextIsStructural =
      nextMeaningful.length === 0 ||
      /^#{1,6}\s+/.test(nextMeaningful) ||
      /^(?:Parameters?|Returns?|Errors?|Throws?):\s*$/i.test(nextMeaningful) ||
      /^-?\s*Examples?:\s*$/i.test(nextMeaningful);

    if (!nextIsStructural) {
      kept.push(line);
    }
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractManualContentFromBlocks(blocks: ManualContentBlock[]): { body: string; figures: ManualFigure[] } {
  const bodyLines: string[] = [];
  const figures: ManualFigure[] = [];
  let numberedListIndex = 1;

  function resetNumberedList() {
    numberedListIndex = 1;
  }

  for (const block of blocks) {
    if (block.type === "heading_1") {
      resetNumberedList();
      const text = richTextToPlainText(block.heading_1?.rich_text);
      if (text) {
        bodyLines.push(`# ${text}`);
      }
      continue;
    }

    if (block.type === "heading_2") {
      resetNumberedList();
      const text = richTextToPlainText(block.heading_2?.rich_text);
      if (text) {
        bodyLines.push(`## ${text}`);
      }
      continue;
    }

    if (block.type === "heading_3") {
      resetNumberedList();
      const text = richTextToPlainText(block.heading_3?.rich_text);
      if (text) {
        bodyLines.push(`### ${text}`);
      }
      continue;
    }

    if (block.type === "paragraph") {
      resetNumberedList();
      const text = richTextToPlainText(block.paragraph?.rich_text);
      if (text) {
        bodyLines.push(text);
      }
      continue;
    }

    if (block.type === "bulleted_list_item") {
      const text = richTextToPlainText(block.bulleted_list_item?.rich_text);
      if (text) {
        bodyLines.push(`- ${text}`);
      }
      continue;
    }

    if (block.type === "numbered_list_item") {
      const text = richTextToPlainText(block.numbered_list_item?.rich_text);
      if (text) {
        bodyLines.push(`${numberedListIndex}. ${text}`);
        numberedListIndex += 1;
      }
      continue;
    }

    if (block.type === "code") {
      const text = richTextToPlainText(block.code?.rich_text);
      if (text) {
        bodyLines.push(`\`\`\`${block.code?.language ?? ""}\n${text}\n\`\`\``);
      }
      continue;
    }

    if (block.type === "image") {
      resetNumberedList();
      const url = block.image?.external?.url ?? block.image?.file?.url;
      if (!url) {
        continue;
      }
      const caption = richTextToPlainText(block.image?.caption) || "Figure";
      figures.push({ url, caption, altText: caption });
    }
  }

  return { body: removeDanglingLabels(bodyLines.join("\n")), figures };
}
