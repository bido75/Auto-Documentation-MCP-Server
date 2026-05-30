import { z } from "zod";

const ContinueYamlStdioServerSchema = z
  .object({
    name: z.string(),
    type: z.literal("stdio").optional(),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    cwd: z.string().optional(),
  })
  .catchall(z.unknown());

const ContinueYamlRemoteServerSchema = z
  .object({
    name: z.string(),
    type: z.union([z.literal("sse"), z.literal("streamable-http")]),
    url: z.string(),
  })
  .catchall(z.unknown());

const ContinueYamlGenericServerSchema = z
  .object({
    name: z.string(),
  })
  .catchall(z.unknown());

export const ContinueYamlConfigSchema = z
  .object({
    mcpServers: z.array(
      z.union([
        ContinueYamlStdioServerSchema,
        ContinueYamlRemoteServerSchema,
        ContinueYamlGenericServerSchema,
      ]),
    ),
  })
  .catchall(z.unknown());

export type ContinueYamlConfig = z.infer<typeof ContinueYamlConfigSchema>;