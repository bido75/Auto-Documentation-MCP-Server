import { z } from "zod";
import { McpServersSchema } from "./core.js";

export const AmazonQMcpConfigSchema = z
  .object({
    mcpServers: McpServersSchema,
    version: z.string().optional(),
  })
  .catchall(z.unknown());

export type AmazonQMcpConfig = z.infer<typeof AmazonQMcpConfigSchema>;
