import { getOptionalRuntimeConfig } from "../config.js";
import { OpenAIProvider } from "./openai.js";

export class BifrostProvider extends OpenAIProvider {
  readonly id: string = "bifrost";
  readonly displayName = `Bifrost Gateway (${getOptionalRuntimeConfig().provider.modelName})`;
}