import { Client } from "@notionhq/client";
import { assertNotionTokenPresent } from "./notion-preflight.js";
import { resolveRuntimeConfig } from "./runtime-context.js";

export function createNotionClient() {
  const runtime = resolveRuntimeConfig();
  assertNotionTokenPresent(runtime.notionToken);
  return new Client({ auth: runtime.notionToken });
}
