import type { ToolDefinition, ToolEffect } from "../types.js";
import { isRetryableEffect, resolveToolEffect } from "../resilience-policy.js";

function cloneValue<T>(value: T, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior) return prior as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneValue(item, seen));
    return copy as T;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = cloneValue(item, seen);
  copySymbolProperties(value, copy);
  return copy as T;
}

// Symbol-keyed properties are harness-attached capability handles (e.g. the
// memory-promotion capability stamped by the approval phase), looked up by
// object IDENTITY in a WeakMap — so they must ride along by reference, never
// deep-cloned, and keep their descriptors (they are non-enumerable on
// purpose: invisible to JSON serialization and Object.entries).
function copySymbolProperties(source: object, target: object): void {
  for (const key of Object.getOwnPropertySymbols(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor) Object.defineProperty(target, key, descriptor);
  }
}

function freezeValue<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freezeValue(item, seen);
  return Object.freeze(value);
}

export interface RetryCallSnapshot {
  readonly args: Readonly<Record<string, unknown>>;
  readonly effect: Readonly<ToolEffect>;
  readonly retryable: boolean;
  freshArgs(): Record<string, unknown>;
}

/** Pin one immutable call identity before execution; attempts receive clones. */
export function createRetryCallSnapshot(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): RetryCallSnapshot {
  const snapshot = freezeValue(cloneValue(args));
  const resolved = resolveToolEffect(tool, snapshot);
  const operationKey = resolved.class === "keyed-mutation" &&
    typeof resolved.operationKey === "string" && resolved.operationKey.trim().length > 0
    ? resolved.operationKey
    : undefined;
  const effect: ToolEffect = Object.freeze(operationKey
    ? { class: resolved.class, operationKey }
    : { class: resolved.class });
  return Object.freeze({
    args: snapshot,
    effect,
    retryable: isRetryableEffect(effect),
    freshArgs: () => cloneValue(snapshot),
  });
}
