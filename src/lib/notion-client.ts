import { Client } from "@notionhq/client";
import { getRuntimeConfig } from "../config.js";

export function createNotionClient() {
  return new Client({ auth: getRuntimeConfig().notionToken });
}
