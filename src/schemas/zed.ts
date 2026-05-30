import { z } from "zod";

const ZedCommandSchema = z
  .object({
    path: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string()).optional(),
  })
  .catchall(z.unknown());

const ZedContextServerSchema = z
  .object({
    command: ZedCommandSchema,
    settings: z.record(z.unknown()),
  })
  .catchall(z.unknown());

export const ZedSettingsSchema = z
  .object({
    context_servers: z.record(ZedContextServerSchema),
  })
  .catchall(z.unknown());

export type ZedSettings = z.infer<typeof ZedSettingsSchema>;
