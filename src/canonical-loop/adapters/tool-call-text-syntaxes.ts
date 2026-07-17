/**
 * Tool-call text syntaxes — the syntax layer of the tool-call-from-text
 * rescue path. tool-call-text-extractor.ts orchestrates; this module only
 * RECOGNIZES shapes. Local/small models leak tool calls into `content` in
 * a zoo of formats beyond bare JSON:
 *
 *   - XML-ish wrapper tags: `<tool_call>{json}</tool_call>`,
 *     `<function_call>…`, `<function=NAME>…</function>`,
 *     `<function name="NAME">…`, `<invoke name="NAME">…`, and
 *     `<execute_tool>` blocks (name on the first line or inside JSON).
 *   - Bracket markers: `[NAME]{json}`, `[tool:NAME]{json}`,
 *     `[TOOL_REQUEST]{envelope}[END_TOOL_REQUEST]`, optional `[/NAME]`.
 *   - Channel-marker leaks: `<|channel|>… to=NAME <|message|>{json}`.
 *
 * Every scanner reports the EXACT source range consumed plus a
 * {name, argsJson} candidate when the block carries enough to reconstruct
 * a call — or a null candidate when the block is recognizable call syntax
 * with nothing usable inside (e.g. `<execute_tool>None</execute_tool>`).
 *
 * Promotion (turning a candidate into a real pending tool call) is the
 * extractor's job. One invariant IS enforced at scan time here: a payload
 * that needed STRUCTURAL repair (closing unbalanced braces/brackets or an
 * unterminated string) never yields a candidate. Balanced output never
 * needs structural completion, so a structural repair is definitionally
 * truncation — and a truncated call must not execute (a partial write or
 * shell command is worse than no call). This module is pure text
 * analysis; findTextToolCallRanges exists so delivery-time sanitization
 * can later scrub unpromoted leak syntax from chat text.
 */

import {
  MAX_ARGS_CHARS,
  MAX_TOOL_NAME_CHARS,
  repairJsonText,
  resolveToolName,
  scanBalancedObject,
} from "./tool-call-text-repair.js";

export interface SyntaxCandidate {
  /** Tool name as the model wrote it — resolve via resolveToolName. */
  name: string;
  /** Argument payload, re-serialized as strictly valid JSON object text. */
  argsJson: string;
}

export interface SyntaxHit {
  start: number;
  end: number;
  candidate: SyntaxCandidate | null;
}

export interface TextToolCallRange {
  start: number;
  end: number;
  promoted: boolean;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Caps gate shared by the extractor's promotion path and range scan. */
export function withinCaps(c: SyntaxCandidate): boolean {
  return c.name.length <= MAX_TOOL_NAME_CHARS && c.argsJson.length <= MAX_ARGS_CHARS;
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
function readJsonPayload(s: string, jsonStart: number): { obj: Record<string, unknown> | null; end: number } {
  const balancedEnd = scanBalancedObject(s, jsonStart);
  const end = balancedEnd === -1 ? s.length : balancedEnd;
  const raw = s.slice(jsonStart, end);
  if (raw.length > MAX_ARGS_CHARS) return { obj: null, end };
  const r = repairJsonText(raw);
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
function envelopeCandidate(obj: Record<string, unknown>): SyntaxCandidate | null {
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

/** Parse `<parameter=K>V</parameter>` / `<parameter name="K">V</parameter>`
 *  pairs. Values that parse as JSON keep their type; the rest stay trimmed
 *  strings. `end` is the offset just past the last closed pair in `body`. */
function parseParameterPairs(body: string): { args: Record<string, unknown>; count: number; end: number } {
  const re = /<parameter(?:\s*=\s*"?([\w.\-]+)"?|\s+name\s*=\s*["']([\w.\-]+)["'])\s*>([\s\S]*?)<\/parameter\s*>/gi;
  const args: Record<string, unknown> = {};
  let count = 0, end = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const key = (m[1] || m[2] || "").trim();
    const rawV = m[3].trim();
    if (key) {
      try { args[key] = JSON.parse(rawV); } catch { args[key] = rawV; }
      count++;
      end = re.lastIndex;
    }
  }
  return { args, count, end };
}

// ----------------------------------------------------------------- scanners

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** Consume an optional closer matching `re` (anchored) right after `e`. */
function consumeCloser(s: string, e: number, re: RegExp): number {
  const m = re.exec(s.slice(e));
  return m ? e + m[0].length : e;
}

/** `<tool_call>{envelope}` / `<function_call>{envelope}` /
 *  `[TOOL_REQUEST]{envelope}` — generic wrappers; the name lives in the JSON. */
function scanWrappedEnvelopeTags(s: string, hits: SyntaxHit[]): void {
  const re = /<(tool_call|function_call)>|\[(TOOL_REQUEST)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const kind = (m[1] || m[2]).toLowerCase();
    const p = skipWs(s, re.lastIndex);
    if (s[p] !== "{") continue;
    const { obj, end } = readJsonPayload(s, p);
    const closer = kind === "tool_request"
      ? /^\s*\[END_TOOL_REQUEST\]/i
      : new RegExp(`^\\s*</${kind}\\s*>`, "i");
    const e = consumeCloser(s, end, closer);
    hits.push({ start: m.index, end: e, candidate: obj ? envelopeCandidate(obj) : null });
    re.lastIndex = e;
  }
}

/** `<function=NAME>` / `<function name="NAME">` / `<invoke name="NAME">` —
 *  name on the tag; payload is a JSON object or `<parameter>` pairs. */
function scanNamedTags(s: string, hits: SyntaxHit[]): void {
  const re = /<(function|invoke)(?:\s*=\s*"?([\w.\-]+)"?|\s+name\s*=\s*["']?([\w.\-]+)["']?)\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const tag = m[1].toLowerCase();
    const name = (m[2] || m[3]).trim();
    const p = skipWs(s, re.lastIndex);
    let argsObj: Record<string, unknown> | null = null;
    let e: number;
    if (s[p] === "{") {
      const payload = readJsonPayload(s, p);
      argsObj = payload.obj;
      e = payload.end;
    } else {
      const closerRe = new RegExp(`</${tag}\\s*>`, "ig");
      closerRe.lastIndex = p;
      const cm = closerRe.exec(s);
      const body = s.slice(p, cm ? cm.index : s.length);
      const pairs = parseParameterPairs(body);
      if (pairs.count > 0) { argsObj = pairs.args; e = p + pairs.end; }
      else if (cm && body.trim() === "") { argsObj = {}; e = cm.index; }
      else if (cm) { e = cm.index; } // unstructured body — recognized, no candidate
      else continue; // no JSON, no pairs, no closer — not call syntax
    }
    e = consumeCloser(s, e, new RegExp(`^\\s*</${tag}\\s*>`, "i"));
    hits.push({ start: m.index, end: e, candidate: name && argsObj ? { name, argsJson: JSON.stringify(argsObj) } : null });
    re.lastIndex = e;
  }
}

const NAME_TOKEN_RE = /^[A-Za-z][\w.\-]*$/;

/** `<execute_tool>` blocks: name on the first line (optionally followed by
 *  JSON args) or a JSON envelope. `None`/empty payloads are a recognized
 *  range with no candidate — the model said "no call" in call clothing. */
function scanExecuteToolBlocks(s: string, hits: SyntaxHit[]): void {
  const re = /<execute_tool>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const p = skipWs(s, re.lastIndex);
    let candidate: SyntaxCandidate | null = null;
    let e: number;
    if (s[p] === "{") {
      const payload = readJsonPayload(s, p);
      candidate = payload.obj ? envelopeCandidate(payload.obj) : null;
      e = payload.end;
    } else {
      const closerRe = /<\/execute_tool\s*>/gi;
      closerRe.lastIndex = p;
      const cm = closerRe.exec(s);
      if (!cm) continue; // bare open tag with no terminator — leave alone
      const inner = s.slice(p, cm.index).trim();
      e = cm.index;
      if (inner && !/^(none|null)$/i.test(inner)) {
        const nl = inner.indexOf("\n");
        const nameLine = (nl === -1 ? inner : inner.slice(0, nl)).trim();
        const rest = nl === -1 ? "" : inner.slice(nl + 1).trim();
        if (NAME_TOKEN_RE.test(nameLine)) {
          if (!rest) candidate = { name: nameLine, argsJson: "{}" };
          else if (rest.startsWith("{")) {
            const payload = readJsonPayload(rest, 0);
            if (payload.obj) {
              // A JSON body may itself be an envelope; prefer its verdict.
              const env = typeof payload.obj.name === "string" ? envelopeCandidate(payload.obj) : null;
              candidate = env ?? { name: nameLine, argsJson: JSON.stringify(payload.obj) };
            }
          }
        }
      }
    }
    e = consumeCloser(s, e, /^\s*<\/execute_tool\s*>/i);
    hits.push({ start: m.index, end: e, candidate });
    re.lastIndex = e;
  }
}

/** `[NAME]{json}` / `[tool:NAME]{json}` with optional `[END_TOOL_REQUEST]`
 *  or `[/NAME]` closers. The weakest marker — a hit requires a parseable
 *  payload so bracketed prose ("[note] {see below}") never registers. */
function scanBracketForms(s: string, hits: SyntaxHit[]): void {
  const re = /\[(tool\s*:\s*)?([A-Za-z][\w.\-]{0,200})\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const name = m[2];
    if (!m[1] && name.toUpperCase() === "TOOL_REQUEST") continue; // envelope wrapper — scanWrappedEnvelopeTags owns it
    const p = skipWs(s, re.lastIndex);
    if (s[p] !== "{") continue;
    const payload = readJsonPayload(s, p);
    if (!payload.obj) continue;
    const e = consumeCloser(
      s, payload.end,
      new RegExp(`^\\s*(?:\\[END_TOOL_REQUEST\\]|\\[/${escapeRegex(name)}\\])`, "i"),
    );
    hits.push({ start: m.index, end: e, candidate: { name, argsJson: JSON.stringify(payload.obj) } });
    re.lastIndex = e;
  }
}

/** Channel-marker leak: `<|channel|>… to=NAME <|message|>{json}` with an
 *  optional trailing `<|call|>`. Router prefixes (`functions.NAME`) are
 *  left on the name — the resolution ladder strips them. */
function scanChannelMarkers(s: string, hits: SyntaxHit[]): void {
  const re = /<\|channel\|>((?:(?!<\|message\|>)[\s\S]){0,300}?)<\|message\|>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const to = /\bto\s*=\s*([\w.\-]+)/.exec(m[1]);
    if (!to) continue; // channel leak without a recipient — not a tool call
    const p = skipWs(s, re.lastIndex);
    if (s[p] !== "{") continue;
    const payload = readJsonPayload(s, p);
    const e = consumeCloser(s, payload.end, /^\s*<\|call\|>/);
    hits.push({ start: m.index, end: e, candidate: payload.obj ? { name: to[1], argsJson: JSON.stringify(payload.obj) } : null });
    re.lastIndex = e;
  }
}

/**
 * Run every syntax scanner over `text` and return non-overlapping hits in
 * source order (earliest start wins; ties prefer the longer range).
 */
export function scanTextToolCallSyntaxes(text: string): SyntaxHit[] {
  if (!text || typeof text !== "string") return [];
  const hits: SyntaxHit[] = [];
  scanWrappedEnvelopeTags(text, hits);
  scanNamedTags(text, hits);
  scanExecuteToolBlocks(text, hits);
  scanBracketForms(text, hits);
  scanChannelMarkers(text, hits);
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: SyntaxHit[] = [];
  let lastEnd = -1;
  for (const h of hits) {
    if (h.start < lastEnd) continue;
    out.push(h);
    lastEnd = h.end;
  }
  return out;
}

// ------------------------------------------------------------- range export

/**
 * Ranges of recognized tool-call syntax with a would-promote verdict.
 * `promoted` = the block yielded a candidate within caps whose name
 * resolves against `validToolNames` (when given; without a tool set the
 * verdict is syntax-only). Structurally-truncated payloads and empty/None
 * blocks never yield candidates, so they always report promoted:false —
 * the same invariant the extractor enforces. This is a pure text scan
 * for delivery-time sanitization to scrub unpromoted leak syntax.
 */
export function findTextToolCallRanges(text: string, validToolNames?: Set<string>): TextToolCallRange[] {
  return scanTextToolCallSyntaxes(text).map((h) => ({
    start: h.start,
    end: h.end,
    promoted: h.candidate !== null && withinCaps(h.candidate) &&
      (validToolNames === undefined || resolveToolName(h.candidate.name, validToolNames) !== null),
  }));
}
