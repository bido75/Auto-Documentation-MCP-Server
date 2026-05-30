import { z } from "zod";
import { McpServersSchema } from "./core.js";

export const PiecesMcpConfigSchema = z
  .object({
    mcpServers: McpServersSchema,
  })
  .catchall(z.unknown());

export type PiecesMcpConfig = z.infer<typeof PiecesMcpConfigSchema>;
