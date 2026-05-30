import { z } from "zod";
import { McpServersSchema } from "./core.js";

export const CodyMcpConfigSchema = z
  .object({
    mcpServers: McpServersSchema,
  })
  .catchall(z.unknown());

export type CodyMcpConfig = z.infer<typeof CodyMcpConfigSchema>;
