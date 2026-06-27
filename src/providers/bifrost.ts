import { resolveOptionalRuntimeConfig } from "../lib/runtime-context.js";
import { OpenAIProvider } from "./openai.js";

export class BifrostProvider extends OpenAIProvider {
  readonly id: string = "bifrost";
  readonly displayName = `Bifrost Gateway (${resolveOptionalRuntimeConfig().provider.modelName})`;
}
