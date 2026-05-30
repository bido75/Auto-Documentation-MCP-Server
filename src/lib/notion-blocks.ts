type RichText = {
  type: "text";
  text: { content: string };
};

type BlockColor =
  | "default"
  | "gray_background"
  | "blue_background"
  | "yellow_background"
  | "red_background"
  | "green_background";

function text(content: string): RichText {
  return { type: "text", text: { content } };
}

function richText(content: string) {
  return [text(content)];
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

export function heading3(content: string) {
  return {
    object: "block" as const,
    type: "heading_3" as const,
    heading_3: {
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

export function callout(content: string, icon: string, color: BlockColor = "default") {
  return {
    object: "block" as const,
    type: "callout" as const,
    callout: {
      rich_text: richText(content),
      icon: { type: "emoji" as const, emoji: icon },
      color,
    },
  };
}

export function bulletedListItem(content: string) {
  return {
    object: "block" as const,
    type: "bulleted_list_item" as const,
    bulleted_list_item: {
      rich_text: richText(content),
    },
  };
}

export function numberedListItem(content: string) {
  return {
    object: "block" as const,
    type: "numbered_list_item" as const,
    numbered_list_item: {
      rich_text: richText(content),
    },
  };
}

export function codeBlock(content: string, language: "plain text" | "sql" | "bash" | "json" | "yaml" | "typescript" | "javascript" | "markdown" | "http" | "powershell" = "plain text") {
  return {
    object: "block" as const,
    type: "code" as const,
    code: {
      rich_text: richText(content),
      language,
    },
  };
}

export function toggle(content: string, children: Array<Record<string, unknown>> = []) {
  return {
    object: "block" as const,
    type: "toggle" as const,
    toggle: {
      rich_text: richText(content),
      children,
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
