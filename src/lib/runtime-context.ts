import { AsyncLocalStorage } from "node:async_hooks";
import { getOptionalRuntimeConfig } from "../config.js";

export type RuntimeContext = {
  notionToken?: string;
  provider?: {
    type?: string;
    endpoint?: string;
    apiKey?: string;
    modelName?: string;
  };
};

const runtimeContextStorage = new AsyncLocalStorage<RuntimeContext>();

export async function runWithRuntimeContext<T>(context: RuntimeContext, fn: () => Promise<T>): Promise<T> {
  const current = runtimeContextStorage.getStore();
  return runtimeContextStorage.run({ ...current, ...context }, fn);
}

export function getRuntimeContext(): RuntimeContext {
  return runtimeContextStorage.getStore() ?? {};
}

export function setRuntimeProviderConfig(provider: NonNullable<RuntimeContext["provider"]>): void {
  const current = runtimeContextStorage.getStore();
  if (!current) {
    return;
  }

  current.provider = { ...current.provider, ...provider };
}

export function resolveOptionalRuntimeConfig(env = process.env) {
  const runtime = getOptionalRuntimeConfig(env);
  const context = getRuntimeContext();
  const withToken = context.notionToken !== undefined ? { ...runtime, notionToken: context.notionToken || undefined } : runtime;
  if (!context.provider) {
    return withToken;
  }

  return {
    ...withToken,
    provider: {
      ...withToken.provider,
      ...context.provider,
    },
  };
}

export function resolveRuntimeConfig(env = process.env) {
  return resolveOptionalRuntimeConfig(env);
}
