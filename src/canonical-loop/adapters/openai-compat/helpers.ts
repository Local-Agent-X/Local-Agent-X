// Tiny shared utilities. extractText probes the common content shapes
// (string, {text}) for canonical messages; parseArgs is the tool-args
// JSON guard; byteLengthUtf8 sizes the provider_state envelope without
// allocating an encoded buffer.

import { MAX_ARGS_CHARS, repairJsonText } from "../tool-call-text-repair.js";

export function extractText(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (typeof c === "object" && "text" in (c as Record<string, unknown>)) {
    const v = (c as { text?: unknown }).text;
    return typeof v === "string" ? v : "";
  }
  return "";
}

/**
 * Tool-args JSON guard. Valid JSON passes through untouched (whatever its
 * type — today's behavior). On a parse failure, run the bounded repair
 * ladder in COSMETIC-only mode: trailing commas and raw control chars are
 * sloppiness in a complete payload and safe to fix, but a payload that
 * needs STRUCTURAL completion (unclosed braces/brackets/strings) is a
 * truncation artifact — finish_reason=length and kin — and must stay
 * `{_raw}` so the failure is loud, exactly like the pre-ladder behavior.
 * Executing a structurally-completed payload would run a PARTIAL write or
 * command. Only an OBJECT result is trusted; over-cap payloads skip the
 * ladder entirely (the cap bounds pathology, not normal args).
 *
 * NOTE: the structured path has a second, independent repair point
 * downstream — tool-execution's resolve-tool.ts parseArgs delegates to
 * arg-repair.ts repairJson (single-quote/bare-key fixes, type coercion).
 * Two ladders, one seam family; unification is a parked follow-up.
 */
export function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { /* repair below */ }
  if (raw.length <= MAX_ARGS_CHARS) {
    const r = repairJsonText(raw);
    if (r !== null && r.kind !== "structural") {
      const v: unknown = JSON.parse(r.text);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    }
  }
  return { _raw: raw };
}

export function byteLengthUtf8(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) len += 1;
    else if (code < 0x800) len += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { len += 4; i++; }
    else len += 3;
  }
  return len;
}
