import { z } from "zod";
import { McpServersSchema } from "./core.js";

export const OpenCodeMcpConfigSchema = z
  .object({
    mcp: z
      .object({
        servers: McpServersSchema,
      })
      .catchall(z.unknown()),
  })
  .catchall(z.unknown());

export type OpenCodeMcpConfig = z.infer<typeof OpenCodeMcpConfigSchema>;
