import { AsyncLocalStorage } from "node:async_hooks";

interface OperationContext {
  opId: string;
}

const operationContext = new AsyncLocalStorage<OperationContext>();

export function runWithOpContext<T>(opId: string, fn: () => T): T {
  return operationContext.run({ opId }, fn);
}

export function getOpId(): string | undefined {
  return operationContext.getStore()?.opId;
}
