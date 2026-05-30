import { AsyncLocalStorage } from "node:async_hooks";

type RuntimeContext = {
  notionToken?: string;
};

const runtimeContextStorage = new AsyncLocalStorage<RuntimeContext>();

export function runWithRuntimeContext<T>(context: RuntimeContext, operation: () => Promise<T>): Promise<T> {
  return runtimeContextStorage.run(context, operation);
}

export function getRuntimeContext(): RuntimeContext {
  return runtimeContextStorage.getStore() ?? {};
}
