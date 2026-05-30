import { z } from "zod";
import { McpServersSchema } from "./core.js";

export const SublimeMcpConfigSchema = z
  .object({
    mcpServers: McpServersSchema,
  })
  .catchall(z.unknown());

export type SublimeMcpConfig = z.infer<typeof SublimeMcpConfigSchema>;
