import { z } from "zod";
import { McpServersSchema } from "./core.js";

export const AntigravityMcpConfigSchema = z
  .object({
    mcpServers: McpServersSchema,
  })
  .catchall(z.unknown());

export type AntigravityMcpConfig = z.infer<typeof AntigravityMcpConfigSchema>;
