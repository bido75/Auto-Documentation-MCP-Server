import { z } from "zod";
import { McpServersSchema } from "./core.js";

export const VsCodeSettingsSchema = z
  .object({
    "github.copilot.mcpServers": McpServersSchema.optional(),
  })
  .catchall(z.unknown());

export type VsCodeSettings = z.infer<typeof VsCodeSettingsSchema>;
