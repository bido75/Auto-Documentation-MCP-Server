import { getOptionalRuntimeConfig } from "../config.js";
import { OpenAIProvider } from "./openai.js";

export class BifrostProvider extends OpenAIProvider {
  readonly id = "bifrost";
  readonly displayName = `Bifrost Gateway (${getOptionalRuntimeConfig().provider.modelName})`;
}