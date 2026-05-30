import { editorValidators } from "./families/editor.js";
import { gooseValidators } from "./families/goose.js";
import { mcpValidators } from "./families/mcp.js";

export const validators = {
  ...mcpValidators,
  ...editorValidators,
  ...gooseValidators,
} as const;

export type ValidatorName = keyof typeof validators;
