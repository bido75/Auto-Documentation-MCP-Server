import { getOptionalRuntimeConfig } from "../config.js";

type RuntimeContext = {
  notionToken?: string;
};

export async function runWithRuntimeContext<T>(context: RuntimeContext, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NOTION_TOKEN;
  if (context.notionToken !== undefined) {
    process.env.NOTION_TOKEN = context.notionToken;
  }

  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.NOTION_TOKEN;
    } else {
      process.env.NOTION_TOKEN = previous;
    }
  }
}

export function resolveRuntimeConfig() {
  return getOptionalRuntimeConfig();
}