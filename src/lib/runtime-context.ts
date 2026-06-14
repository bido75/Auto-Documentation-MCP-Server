import { AsyncLocalStorage } from "node:async_hooks";
import { getOptionalRuntimeConfig } from "../config.js";

export type RuntimeContext = {
  notionToken?: string;
};

const runtimeContextStorage = new AsyncLocalStorage<RuntimeContext>();

export async function runWithRuntimeContext<T>(context: RuntimeContext, fn: () => Promise<T>): Promise<T> {
  const current = runtimeContextStorage.getStore();
  return runtimeContextStorage.run({ ...current, ...context }, fn);
}

export function getRuntimeContext(): RuntimeContext {
  return runtimeContextStorage.getStore() ?? {};
}

export function resolveRuntimeConfig(env = process.env) {
  const runtime = getOptionalRuntimeConfig(env);
  const context = getRuntimeContext();
  return context.notionToken !== undefined ? { ...runtime, notionToken: context.notionToken || undefined } : runtime;
}
