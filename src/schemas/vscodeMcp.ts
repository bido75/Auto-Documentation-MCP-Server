import { z } from "zod";

const VsCodeLocalMcpServerSchema = z
  .object({
    type: z.literal("stdio").optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  })
  .catchall(z.unknown());

const VsCodeRemoteMcpServerSchema = z
  .object({
    type: z.union([z.literal("http"), z.literal("sse")]),
    url: z.string(),
  })
  .catchall(z.unknown());

export const VsCodeMcpConfigSchema = z
  .object({
    servers: z.record(z.union([VsCodeLocalMcpServerSchema, VsCodeRemoteMcpServerSchema])),
  })
  .catchall(z.unknown());

export type VsCodeMcpConfig = z.infer<typeof VsCodeMcpConfigSchema>;