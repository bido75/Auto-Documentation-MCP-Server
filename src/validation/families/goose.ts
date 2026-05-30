import { z } from "zod";
import { GooseConfigSchema } from "../../schemas/goose.js";

type Validator<T> = (value: unknown) => T;

function makeValidator<T>(schema: z.ZodType<T>): Validator<T> {
  return (value: unknown) => schema.parse(value);
}

export const gooseValidators = {
  goose: makeValidator(GooseConfigSchema),
} as const;

export type GooseValidatorName = keyof typeof gooseValidators;
