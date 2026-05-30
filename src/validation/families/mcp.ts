import { z } from "zod";
import { AmazonQMcpConfigSchema } from "../../schemas/amazonQ.js";
import { AntigravityMcpConfigSchema } from "../../schemas/antigravity.js";
import { ClaudeCodeMcpConfigSchema } from "../../schemas/claudeCode.js";
import { GenericMcpConfigSchema } from "../../schemas/core.js";
import { KlineCodeMcpConfigSchema } from "../../schemas/klineCode.js";

type Validator<T> = (value: unknown) => T;

function makeValidator<T>(schema: z.ZodType<T>): Validator<T> {
  return (value: unknown) => schema.parse(value);
}

export const mcpValidators = {
  genericMcp: makeValidator(GenericMcpConfigSchema),
  claudeCode: makeValidator(ClaudeCodeMcpConfigSchema),
  amazonQ: makeValidator(AmazonQMcpConfigSchema),
  klineCode: makeValidator(KlineCodeMcpConfigSchema),
  antigravity: makeValidator(AntigravityMcpConfigSchema),
} as const;

export type McpValidatorName = keyof typeof mcpValidators;
