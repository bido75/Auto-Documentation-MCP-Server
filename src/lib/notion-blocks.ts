type RichText = {
  type: "text";
  text: { content: string };
};

const NOTION_RICH_TEXT_CONTENT_LIMIT = 2000;

function text(content: string): RichText {
  return { type: "text", text: { content } };
}

function richText(content: string): RichText[] {
  if (content.length <= NOTION_RICH_TEXT_CONTENT_LIMIT) {
    return [text(content)];
  }

  const parts: RichText[] = [];
  for (let index = 0; index < content.length; index += NOTION_RICH_TEXT_CONTENT_LIMIT) {
    parts.push(text(content.slice(index, index + NOTION_RICH_TEXT_CONTENT_LIMIT)));
  }
  return parts;
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
