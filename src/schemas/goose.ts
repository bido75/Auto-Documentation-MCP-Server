import { z } from "zod";

const GooseExtensionSchema = z
  .object({
    name: z.string(),
    type: z.literal("stdio"),
    cmd: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string()).optional(),
    enabled: z.boolean(),
  })
  .catchall(z.unknown());

export const GooseConfigSchema = z
  .object({
    extensions: z.array(GooseExtensionSchema),
  })
  .catchall(z.unknown());

export type GooseConfig = z.infer<typeof GooseConfigSchema>;