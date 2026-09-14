import { resolveOptionalRuntimeConfig } from "../lib/runtime-context.js";
import { OpenAIProvider } from "./openai.js";

export class VllmProvider extends OpenAIProvider {
  readonly id = "local-vllm";
  readonly displayName = `vLLM (${resolveOptionalRuntimeConfig().provider.modelName})`;
}
