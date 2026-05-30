import { z } from "zod";
import { McpServersSchema } from "./core.js";

export const ClaudeCodeMcpConfigSchema = z
  .object({
    mcpServers: McpServersSchema,
  })
  .catchall(z.unknown());

export type ClaudeCodeMcpConfig = z.infer<typeof ClaudeCodeMcpConfigSchema>;
