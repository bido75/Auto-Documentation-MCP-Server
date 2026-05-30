import { z } from "zod";

export const McpServerEntrySchema = z
  .object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .catchall(z.unknown());

export const McpServersSchema = z.record(McpServerEntrySchema);

export const GenericMcpConfigSchema = z
  .object({
    mcpServers: McpServersSchema,
  })
  .catchall(z.unknown());

export type GenericMcpConfig = z.infer<typeof GenericMcpConfigSchema>;
