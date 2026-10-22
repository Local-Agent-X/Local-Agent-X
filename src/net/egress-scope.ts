/**
 * Which session a tool's outbound request belongs to, for the send-time judge
 * (egress-send.ts). The tool runner opens one scope around every tool's
 * execute (tool-execution/tool-runner.ts), so a request a tool makes through
 * the shared transport is judged against the session whose taint and canaries
 * it could carry, without each tool passing the session down. Outside a scope
 * (a route, a background job) there is no session to judge taint against;
 * the known-secret check still runs.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<{ sessionId: string }>();

export function runInEgressScope<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return scope.run({ sessionId }, fn);
}

/** The session the current tool call runs for, or null outside a tool call. */
export function egressSessionId(): string | null {
  return scope.getStore()?.sessionId ?? null;
}
