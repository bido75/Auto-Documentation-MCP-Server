type RichText = {
  type: "text";
  text: { content: string };
};

function text(content: string): RichText {
  return { type: "text", text: { content } };
}

export function heading2(content: string) {
  return {
    object: "block" as const,
    type: "heading_2" as const,
    heading_2: {
      rich_text: [text(content)],
    },
  };
}

export function paragraph(content: string) {
  return {
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: {
      rich_text: [text(content)],
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
