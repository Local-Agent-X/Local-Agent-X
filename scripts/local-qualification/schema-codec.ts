import { createHash } from "node:crypto";
import { CREDENTIAL_PATTERNS } from "../../src/security/secrets/credential-patterns.js";
import { detectHighEntropyTokens } from "../../src/security/secrets/entropy-detector.js";

export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function exact(row: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(row).sort(compareCodePoints);
  const expected = [...keys].sort(compareCodePoints);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains unknown or missing fields`);
  }
}

export function opaqueText(value: unknown, label: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function text(value: unknown, label: string, pattern: RegExp): string {
  const parsed = opaqueText(value, label, pattern);
  const credentialShaped = CREDENTIAL_PATTERNS.some(({ regex }) => new RegExp(regex.source, regex.flags).test(parsed));
  if (credentialShaped || detectHighEntropyTokens(parsed).length > 0) throw new Error(`${label} contains secret-shaped data`);
  return parsed;
}

export function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`${label} is invalid`);
  return Number(value);
}

export function stringArray(value: unknown, label: string, pattern: RegExp): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values = value.map((item, index) => text(item, `${label}[${index}]`, pattern));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values.sort(compareCodePoints);
}

export function opaqueStringArray(value: unknown, label: string, pattern: RegExp): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values = value.map((item, index) => opaqueText(item, `${label}[${index}]`, pattern));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values.sort(compareCodePoints);
}

export function safeSum(values: number[], label: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error(`${label} exceeds the safe integer range`);
  }
  return total;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}
