import { withNotionRetry } from "./notion-retry.js";

type RichTextPart = { plain_text?: string; text?: { content?: string } };
type BlockChildrenListResponse = { results: NotionBlock[]; has_more?: boolean; next_cursor?: string | null };
type NotionBlock = {
    id: string;
    type: string;
    has_children?: boolean;
    _children?: NotionBlock[];
    heading_1?: { rich_text?: RichTextPart[] };
    heading_2?: { rich_text?: RichTextPart[] };
    heading_3?: { rich_text?: RichTextPart[] };
    paragraph?: { rich_text?: RichTextPart[] };
    bulleted_list_item?: { rich_text?: RichTextPart[] };
    numbered_list_item?: { rich_text?: RichTextPart[] };
    code?: { rich_text?: RichTextPart[]; language?: string };
    callout?: { rich_text?: RichTextPart[]; icon?: { emoji?: string } };
    quote?: { rich_text?: RichTextPart[] };
    toggle?: { rich_text?: RichTextPart[] };
};
type NotionBlockClient = {
    blocks: {
        children: {
            list(input: { block_id: string; page_size: number; start_cursor?: string }): Promise<BlockChildrenListResponse>;
        };
    };
};

export async function fetchAllBlocks(notion: NotionBlockClient, blockId: string): Promise<NotionBlock[]> {
    const results: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
        const payload = {
            block_id: blockId,
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
        };
        const page = (await withNotionRetry(() => notion.blocks.children.list(payload), {
            operationName: "blocks.children.list",
            payload,
        })) as BlockChildrenListResponse;
        results.push(...page.results);
        cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
    } while (cursor);
    for (const block of results) {
        if (block.has_children) {
            block._children = await fetchAllBlocks(notion, block.id);
        }
    }
    return results;
}
export function blocksToMarkdown(blocks: NotionBlock[], depth = 0): string {
    const indent = "  ".repeat(depth);
    const rich = (parts?: RichTextPart[]) => parts?.map((part) => part.plain_text ?? part.text?.content ?? "").join("") ?? "";
    return blocks
        .map((block) => {
        switch (block.type) {
            case "heading_1":
                return `\n# ${rich(block.heading_1?.rich_text)}\n`;
            case "heading_2":
                return `\n## ${rich(block.heading_2?.rich_text)}\n`;
            case "heading_3":
                return `\n### ${rich(block.heading_3?.rich_text)}\n`;
            case "paragraph":
                return `\n${indent}${rich(block.paragraph?.rich_text)}\n`;
            case "bulleted_list_item":
                return `${indent}- ${rich(block.bulleted_list_item?.rich_text)}`;
            case "numbered_list_item":
                return `${indent}1. ${rich(block.numbered_list_item?.rich_text)}`;
            case "code":
                return `\n\`\`\`${block.code?.language ?? "text"}\n${rich(block.code?.rich_text)}\n\`\`\`\n`;
            case "callout":
                return `\n> **${block.callout?.icon?.emoji ?? "INFO"}** ${rich(block.callout?.rich_text)}\n`;
            case "quote":
                return `\n> ${rich(block.quote?.rich_text)}\n`;
            case "divider":
                return "\n---\n";
            case "toggle": {
                const content = block._children ? blocksToMarkdown(block._children, depth + 1) : "";
                return `\n<details><summary>${rich(block.toggle?.rich_text)}</summary>\n\n${content}\n</details>\n`;
            }
            default:
                return block._children ? blocksToMarkdown(block._children, depth + 1) : "";
        }
    })
        .join("\n")
        .trim();
}
