import { isProxy } from "node:util/types";
import type { LearnedEvidenceIdentity } from "./types.js";

export const MISSING_PROPERTY = Symbol("missing-property");
export const INVALID_PROPERTY = Symbol("invalid-property");

export function ownDataValue(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== "object" || isProxy(value)) return INVALID_PROPERTY;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return MISSING_PROPERTY;
    return descriptor.enumerable && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : INVALID_PROPERTY;
  } catch {
    return INVALID_PROPERTY;
  }
}

export function readOwnEnumerableData(value: unknown, key: PropertyKey): { ok: true; value: unknown } | { ok: false } {
  const result = ownDataValue(value, key);
  return result === MISSING_PROPERTY || result === INVALID_PROPERTY ? { ok: false } : { ok: true, value: result };
}

export function hasEvidenceIdentity(value: unknown, expected: LearnedEvidenceIdentity): boolean {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  try {
    if (Array.isArray(value)) return false;
    const expectedClass = ownDataValue(expected, "evidenceClass");
    const expectedAuthority = ownDataValue(expected, "authority");
    if (typeof expectedClass !== "string" || typeof expectedAuthority !== "string") return false;
    const evidenceClass = Object.getOwnPropertyDescriptor(value, "evidenceClass");
    const authority = Object.getOwnPropertyDescriptor(value, "authority");
    return !!evidenceClass && !!authority && evidenceClass.enumerable === true && authority.enumerable === true
      && Object.hasOwn(evidenceClass, "value") && Object.hasOwn(authority, "value")
      && evidenceClass.value === expectedClass && authority.value === expectedAuthority;
  } catch { return false; }
}

export function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value)) return false;
  try { return !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
  catch { return false; }
}

export function exactKeys(value: object, allowed: ReadonlySet<string>, required: readonly string[] = []): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) return false;
    if (required.some((key) => !keys.includes(key))) return false;
    return keys.every((key) => key === "length" || ownDataValue(value, key) !== INVALID_PROPERTY);
  } catch { return false; }
}

export function denseArray(value: unknown, maxLength = 5000): unknown[] | null {
  if (!value || typeof value !== "object" || isProxy(value)) return null;
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !Object.hasOwn(length, "value") || !Number.isSafeInteger(length.value)
      || length.value < 0 || length.value > maxLength) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length.value + 1 || keys.some((key) => typeof key !== "string")) return null;
    const copy: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      const entry = ownDataValue(value, String(index));
      if (entry === MISSING_PROPERTY || entry === INVALID_PROPERTY) return null;
      copy.push(entry);
    }
    return copy;
  } catch { return null; }
}

export function stringArray(value: unknown, maxLength = 1000): value is string[] {
  const items = denseArray(value, maxLength);
  return items !== null && items.every((item) => typeof item === "string");
}

export function isSafeLearnedStringArray(value: unknown): value is string[] { return stringArray(value); }

export function optional(value: object, key: string, valid: (entry: unknown) => boolean): boolean {
  const entry = ownDataValue(value, key);
  return entry === MISSING_PROPERTY || (entry !== INVALID_PROPERTY && entry !== undefined && valid(entry));
}

export function safeJson(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || isProxy(value) || seen.has(value)) return false;
  seen.add(value);
  const array = denseArray(value);
  if (array) return array.every((entry) => safeJson(entry, seen));
  if (!plainRecord(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.every((key) => typeof key === "string" && ownDataValue(value, key) !== INVALID_PROPERTY
      && safeJson(ownDataValue(value, key), seen));
  } catch { return false; }
}
