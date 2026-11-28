/**
 * Payload interpretation for the tool-call text scanners
 * (tool-call-text-scanners.ts): reading a JSON payload off the text,
 * turning a parsed object or a run of `<parameter>` pairs into a
 * {name, argsJson} candidate, and the `<execute_tool>` body grammar.
 * Extracted from the scanners: they recognize a call's shape and source
 * range, this module reads its payload.
 *
 * The truncation invariant starts here: readJsonPayload yields no object
 * for a payload that needed STRUCTURAL repair, so a cut-off payload can
 * become a recognized range but never a candidate.
 */

import {
  type BalancedScanMemo,
  MAX_ARGS_CHARS,
  repairJsonText,
  scanBalancedObject,
} from "./tool-call-text-repair.js";
import { NAMESPACE_PREFIX, PARAMETER_TAG, closerSource } from "./tool-call-text-tags.js";

export interface SyntaxCandidate {
  /** Tool name as the model wrote it — resolve via resolveToolName. */
  name: string;
  /** Argument payload, re-serialized as strictly valid JSON object text. */
  argsJson: string;
  /**
   * Set when the marker was too weak to justify fuzzy name resolution
   * (`[NAME]{json}` — bracketed prose followed by a brace is common):
   * promote only on an EXACT match against the offered set.
   */
  exactNameOnly?: boolean;
}

export interface SyntaxHit {
  start: number;
  end: number;
  candidate: SyntaxCandidate | null;
}

/** One scan's source text plus the balanced-brace memo every payload read
 *  shares — the memo is what keeps a page of unbalanced openers linear. */
export interface ScanSource {
  text: string;
  memo: BalancedScanMemo;
}

export function scanSource(text: string): ScanSource {
  return { text, memo: new Map() };
}

// ------------------------------------------------------------ JSON payloads

/**
 * Read a JSON object payload at `jsonStart` (must sit on a "{"). Always
 * returns the consumed end (end-of-input when the braces never balance);
 * `obj` is null when the payload is over-cap, unsalvageable, or needed
 * STRUCTURAL repair — an unbalanced payload is a truncation artifact and
 * must never become a candidate, only a recognized range. Cosmetic
 * repairs (trailing commas, raw control chars) are fine: the payload was
 * complete, just sloppy.
 */
export function readJsonPayload(src: ScanSource, jsonStart: number): { obj: Record<string, unknown> | null; end: number } {
  const s = src.text;
  const balancedEnd = scanBalancedObject(s, jsonStart, src.memo);
  // Never balanced = truncated by definition (the repair ladder could only
  // complete it STRUCTURALLY) — and never worth a repair walk over the
  // whole tail once per opener. Over-cap: same verdict, no parse.
  if (balancedEnd === -1) return { obj: null, end: s.length };
  const end = balancedEnd;
  if (end - jsonStart > MAX_ARGS_CHARS) return { obj: null, end };
  const r = repairJsonText(s.slice(jsonStart, end));
  if (r !== null && r.kind !== "structural") {
    const parsed: unknown = JSON.parse(r.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { obj: parsed as Record<string, unknown>, end };
    }
  }
  return { obj: null, end };
}

// ----------------------------------------------------------- interpretation

const ENVELOPE_NAME_KEYS = ["name", "tool", "tool_name"];
const ENVELOPE_ARGS_KEYS = ["arguments", "parameters", "params", "args", "input"];

/**
 * Browser-shorthand payload shape: `{action: "X", ref: N, ...}` — the
 * browser tool's signature arg shape with no name wrapper. ONE set of
 * shape rules shared by the extractor's naked-JSON classifier (layer 2)
 * and envelope interpretation here, so wrapped shorthand
 * (`<tool_call>{"action":…}`) promotes exactly like naked shorthand.
 * Callers decide whether a `browser` tool is actually offered.
 */
export function isBrowserShorthand(obj: Record<string, unknown>): boolean {
  if (typeof obj.action !== "string") return false;
  return "ref" in obj || "coords" in obj || "text" in obj ||
    "url" in obj || "target" in obj || "key" in obj ||
    "selector" in obj || obj.action === "snapshot" || obj.action === "back" ||
    obj.action === "forward" || obj.action === "wait";
}

/**
 * Interpret a parsed payload object as a call envelope. Honors the wire
 * shape ({name, arguments}), the nested {function:{name,arguments}} form,
 * key aliases, string-serialized arguments (cosmetic repair only), the
 * flattened form where args ride at top level next to `name`, and the
 * nameless browser-shorthand arg shape.
 */
export function envelopeCandidate(obj: Record<string, unknown>): SyntaxCandidate | null {
  const fn = obj.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    return envelopeCandidate(fn as Record<string, unknown>);
  }
  let name: string | null = null;
  for (const k of ENVELOPE_NAME_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) { name = v.trim(); break; }
  }
  if (!name) {
    // No envelope name — but the payload may be the browser shorthand,
    // which the naked-JSON layer promoted long before wrapper tags were
    // parsed. Wrapping the same payload must not lose the rescue.
    return isBrowserShorthand(obj) ? { name: "browser", argsJson: JSON.stringify(obj) } : null;
  }
  let args: unknown;
  let argsKey: string | null = null;
  for (const k of ENVELOPE_ARGS_KEYS) {
    if (obj[k] !== undefined) { args = obj[k]; argsKey = k; break; }
  }
  if (typeof args === "string") {
    // Serialized-args string: accept only cosmetic repair. A string that
    // needs structural completion is broken mid-write — don't guess.
    const r = repairJsonText(args);
    if (r !== null && r.kind !== "structural") args = JSON.parse(r.text);
  }
  if (argsKey === null) {
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!ENVELOPE_NAME_KEYS.includes(k) && k !== "type" && k !== "id") rest[k] = v;
    }
    args = rest;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return { name, argsJson: JSON.stringify(args) };
}

/** `<parameter=K>V</parameter>` / `<parameter name="K">V</parameter>`,
 *  namespace-tolerant on both tags. Group 1/2 = key, group 3 = value. */
export const PARAMETER_PAIR_SRC =
  String.raw`<\s*${NAMESPACE_PREFIX}${PARAMETER_TAG}(?:\s*=\s*"?([\w.\-]+)"?|\s+name\s*=\s*["']([\w.\-]+)["'])\s*>` +
  String.raw`([\s\S]*?)` + closerSource([PARAMETER_TAG]);

/** A `<parameter>` opener or closer on its own, namespace-tolerant. */
const PARAMETER_TAG_RE = new RegExp(
  String.raw`<\s*${NAMESPACE_PREFIX}${PARAMETER_TAG}\b|` + closerSource([PARAMETER_TAG]), "i");

/**
 * Parse parameter pairs. Values that parse as JSON keep their type; the
 * rest stay trimmed strings. `end` is the offset just past the last
 * closed pair in `body`.
 *
 * `whole` is the pair form of the truncation invariant: false when a
 * `<parameter>` tag is left over outside the closed pairs. An opener with
 * no closer is an argument that was still being written when the block's
 * closer arrived (or whose value holds that closer); a closer with no
 * opener is what remains of a value that held `</parameter>` and was cut
 * at it. Either way the closed pairs are part of a call, not the call:
 * `write` with its path and no content, `bash` with half its command.
 */
export function parseParameterPairs(body: string): { args: Record<string, unknown>; count: number; end: number; whole: boolean } {
  const re = new RegExp(PARAMETER_PAIR_SRC, "gi");
  const args: Record<string, unknown> = {};
  let count = 0, end = 0;
  let outside = "";
  let from = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    outside += body.slice(from, m.index);
    from = re.lastIndex;
    const key = (m[1] || m[2] || "").trim();
    const rawV = m[3].trim();
    if (key) {
      try { args[key] = JSON.parse(rawV); } catch { args[key] = rawV; }
      count++;
      end = re.lastIndex;
    }
  }
  outside += body.slice(from);
  return { args, count, end, whole: !PARAMETER_TAG_RE.test(outside) };
}

const NAME_TOKEN_RE = /^[A-Za-z][\w.\-]*$/;

/** `<execute_tool>` body grammar: name on the first line, optionally
 *  followed by JSON args (which may itself be an envelope). `None`/empty
 *  is the model saying "no call" in call clothing — no candidate. */
export function executeToolCandidate(inner: string): SyntaxCandidate | null {
  if (!inner || /^(none|null)$/i.test(inner)) return null;
  const nl = inner.indexOf("\n");
  const nameLine = (nl === -1 ? inner : inner.slice(0, nl)).trim();
  const rest = nl === -1 ? "" : inner.slice(nl + 1).trim();
  if (!NAME_TOKEN_RE.test(nameLine)) return null;
  if (!rest) return { name: nameLine, argsJson: "{}" };
  if (!rest.startsWith("{")) return null;
  const payload = readJsonPayload(scanSource(rest), 0);
  if (!payload.obj) return null;
  const env = typeof payload.obj.name === "string" ? envelopeCandidate(payload.obj) : null;
  return env ?? { name: nameLine, argsJson: JSON.stringify(payload.obj) };
}
