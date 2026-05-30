import { z } from "zod";
import { McpServersSchema } from "./core.js";

export const KlineCodeMcpConfigSchema = z
  .object({
    mcpServers: McpServersSchema,
  })
  .catchall(z.unknown());

export type KlineCodeMcpConfig = z.infer<typeof KlineCodeMcpConfigSchema>;
