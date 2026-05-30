import { z } from "zod";
import { ContinueYamlConfigSchema } from "../../schemas/continueYaml.js";
import { OpenCodeMcpConfigSchema } from "../../schemas/openCode.js";
import { VsCodeMcpConfigSchema } from "../../schemas/vscodeMcp.js";
import { ZedSettingsSchema } from "../../schemas/zed.js";

type Validator<T> = (value: unknown) => T;

function makeValidator<T>(schema: z.ZodType<T>): Validator<T> {
  return (value: unknown) => schema.parse(value);
}

export const editorValidators = {
  openCode: makeValidator(OpenCodeMcpConfigSchema),
  continueYaml: makeValidator(ContinueYamlConfigSchema),
  vscodeMcp: makeValidator(VsCodeMcpConfigSchema),
  zed: makeValidator(ZedSettingsSchema),
} as const;

export type EditorValidatorName = keyof typeof editorValidators;
