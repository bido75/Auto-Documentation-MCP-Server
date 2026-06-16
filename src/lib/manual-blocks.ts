import type { ManualFigure } from "../types.js";

type RichTextPart = { plain_text?: string; text?: { content?: string } };
type ManualContentBlock = {
  type?: string;
  paragraph?: { rich_text?: RichTextPart[] };
  image?: {
    type?: "external" | "file";
    external?: { url?: string };
    file?: { url?: string };
    caption?: RichTextPart[];
  };
};

function richTextToPlainText(parts: RichTextPart[] | undefined): string {
  return (parts ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("").trim();
}

export function extractManualContentFromBlocks(blocks: ManualContentBlock[]): { body: string; figures: ManualFigure[] } {
  const bodyLines: string[] = [];
  const figures: ManualFigure[] = [];

  for (const block of blocks) {
    if (block.type === "paragraph") {
      const text = richTextToPlainText(block.paragraph?.rich_text);
      if (text) {
        bodyLines.push(text);
      }
      continue;
    }

    if (block.type === "image") {
      const url = block.image?.external?.url ?? block.image?.file?.url;
      if (!url) {
        continue;
      }
      const caption = richTextToPlainText(block.image?.caption) || "Figure";
      figures.push({ url, caption, altText: caption });
    }
  }

  return { body: bodyLines.join("\n"), figures };
}
