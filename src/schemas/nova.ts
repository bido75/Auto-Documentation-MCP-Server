import { z } from "zod";
import { McpServersSchema } from "./core.js";

export const NovaMcpConfigSchema = z
  .object({
    mcpServers: McpServersSchema,
  })
  .catchall(z.unknown());

export type NovaMcpConfig = z.infer<typeof NovaMcpConfigSchema>;
