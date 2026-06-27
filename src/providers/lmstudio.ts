import { resolveOptionalRuntimeConfig } from "../lib/runtime-context.js";
import { OpenAIProvider } from "./openai.js";

export class LMStudioProvider extends OpenAIProvider {
  readonly id = "local-lmstudio";
  readonly displayName = `LM Studio (${resolveOptionalRuntimeConfig().provider.modelName})`;
}
