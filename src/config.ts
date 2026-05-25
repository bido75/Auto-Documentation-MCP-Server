import { assertNotionTokenPresent } from "./lib/notion-preflight.js";

export type PublishingMode = "Conservative" | "Balanced" | "Fully Automatic";

export interface RuntimeConfig {
  notionToken: string;
  defaultPublishingMode: PublishingMode;
  defaultAutoPublishThreshold: number;
}

export function getRuntimeConfig(env = process.env): RuntimeConfig {
  const notionToken = env.NOTION_TOKEN;
  assertNotionTokenPresent(notionToken);
  const resolvedNotionToken = notionToken as string;

  return {
    notionToken: resolvedNotionToken,
    defaultPublishingMode: "Balanced",
    defaultAutoPublishThreshold: 90,
  };
}
