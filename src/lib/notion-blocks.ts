type RichText = {
  type: "text";
  text: { content: string };
  annotations?: { bold?: boolean };
};
type CodeLanguage = "javascript" | "typescript" | "shell" | "json" | "plain text";

const NOTION_RICH_TEXT_CONTENT_LIMIT = 2000;

function sanitizeTextContent(content: string): string {
  return content.replace(/\u0000/g, "");
}

function removeDanglingLabels(content: string): string {
  const lines = sanitizeTextContent(content).split(/\r?\n/);
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

function text(content: string, annotations?: RichText["annotations"]): RichText {
  return { type: "text", text: { content: sanitizeTextContent(content) }, ...(annotations ? { annotations } : {}) };
}

function richText(content: string): RichText[] {
  const sanitized = sanitizeTextContent(content);
  if (sanitized.length <= NOTION_RICH_TEXT_CONTENT_LIMIT) {
    return [text(sanitized)];
  }

  const parts: RichText[] = [];
  for (let index = 0; index < sanitized.length; index += NOTION_RICH_TEXT_CONTENT_LIMIT) {
    parts.push(text(sanitized.slice(index, index + NOTION_RICH_TEXT_CONTENT_LIMIT)));
  }
  return parts;
}

function markdownRichText(content: string): RichText[] {
  const parts: RichText[] = [];
  let remaining = sanitizeTextContent(content);
  while (remaining.length > 0) {
    const match = /\*\*([^*]+)\*\*/.exec(remaining);
    if (!match || match.index === undefined) {
      parts.push(...richText(remaining));
      break;
    }
    const before = remaining.slice(0, match.index);
    if (before) {
      parts.push(...richText(before));
    }
    parts.push(text(match[1], { bold: true }));
    remaining = remaining.slice(match.index + match[0].length);
  }
  return parts.length > 0 ? parts : richText(content);
}

export function heading2(content: string) {
  return {
    object: "block" as const,
    type: "heading_2" as const,
    heading_2: {
      rich_text: richText(content),
    },
  };
}

export function paragraph(content: string) {
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: {
      rich_text: richText(content),
    },
  };
}

function paragraphFromMarkdown(content: string) {
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: {
      rich_text: markdownRichText(content),
    },
  };
}

export function paragraphs(content: string) {
  return content
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(paragraph);
}

export function divider() {
  return {
    object: "block" as const,
    type: "divider" as const,
    divider: {},
  };
}

export function heading1(content: string) {
  return {
    object: "block" as const,
    type: "heading_1" as const,
    heading_1: {
      rich_text: richText(content),
    },
  };
}

export function heading3(content: string) {
  return {
    object: "block" as const,
    type: "heading_3" as const,
    heading_3: {
      rich_text: richText(content),
    },
  };
}

export function image(url: string, caption: string) {
  return {
    object: "block" as const,
    type: "image" as const,
    image: {
      type: "external" as const,
      external: { url },
      caption: caption.trim().length > 0 ? [text(caption)] : [],
    },
  };
}

function normalizeCodeLanguage(input: string): CodeLanguage {
  const normalized = input.trim().toLowerCase();
  if (normalized === "js" || normalized === "javascript") {
    return "javascript";
  }
  if (normalized === "ts" || normalized === "typescript") {
    return "typescript";
  }
  if (normalized === "bash" || normalized === "sh" || normalized === "shell" || normalized === "powershell") {
    return "shell";
  }
  if (normalized === "json") {
    return "json";
  }
  return "plain text";
}

export function markdownBlocks(content: string) {
  const blocks: Array<
    | ReturnType<typeof heading1>
    | ReturnType<typeof heading2>
    | ReturnType<typeof heading3>
    | ReturnType<typeof paragraph>
    | {
        object: "block";
        type: "bulleted_list_item";
        bulleted_list_item: { rich_text: RichText[] };
      }
    | {
        object: "block";
        type: "numbered_list_item";
        numbered_list_item: { rich_text: RichText[] };
      }
    | {
        object: "block";
        type: "code";
        code: { rich_text: RichText[]; language: CodeLanguage };
      }
  > = [];
  const lines = removeDanglingLabels(content).split(/\r?\n/);
  let paragraphLines: string[] = [];
  let codeLines: string[] = [];
  let codeLanguage = "plain text";

  function flushParagraph() {
    const textContent = paragraphLines.join("\n").trim();
    if (textContent) {
      blocks.push(paragraphFromMarkdown(textContent));
    }
    paragraphLines = [];
  }

  function flushCode() {
    blocks.push({
      object: "block",
      type: "code",
      code: {
        rich_text: richText(codeLines.join("\n")),
        language: normalizeCodeLanguage(codeLanguage),
      },
    });
    codeLines = [];
    codeLanguage = "plain text";
  }

  let inCode = false;
  for (const line of lines) {
    const fence = /^```([A-Za-z0-9 _-]+)?\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        codeLanguage = fence[1] ?? "plain text";
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const headingText = heading[2].trim();
      blocks.push(level === 1 ? heading1(headingText) : level === 2 ? heading2(headingText) : heading3(headingText));
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: markdownRichText(bullet[1].trim()) },
      });
      continue;
    }

    const numbered = /^\d+\.\s+(.+)$/.exec(line);
    if (numbered) {
      flushParagraph();
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: { rich_text: markdownRichText(numbered[1].trim()) },
      });
      continue;
    }

    paragraphLines.push(line);
  }

  if (inCode) {
    flushCode();
  }
  flushParagraph();
  return blocks;
}
