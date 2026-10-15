// Narrowing helpers for the parsers in this package. Every frame that crosses a device
// boundary arrives as untrusted JSON; these turn `unknown` into checked values.

export type Rec = Record<string, unknown>;

export function asRecord(v: unknown): Rec | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : null;
}

export function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A string-valued map: entries whose value is not a string are dropped. */
export function asStringMap(v: unknown): Record<string, string> | null {
  const rec = asRecord(v);
  if (rec === null) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(rec)) if (typeof val === "string") out[k] = val;
  return out;
}
