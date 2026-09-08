/**
 * Tool-call text scanners — the shape recognizers behind
 * tool-call-text-syntaxes.ts (which owns the public API, hit-overlap
 * resolution and the range export). Payload interpretation lives in
 * tool-call-text-interpret.ts; tag names come exclusively from
 * tool-call-text-tags.ts, so every scanner accepts the optional namespace
 * prefix on openers, closers and `<parameter>` pairs.
 *
 * Each scanner reports the EXACT source range consumed plus a
 * {name, argsJson} candidate when the block carries enough to reconstruct
 * a call — or a null candidate when the block is recognizable call syntax
 * with nothing usable inside: `<execute_tool>None</execute_tool>`, a
 * `<tool_result>` block, a lone closer, an orphan `<parameter>` pair.
 *
 * Truncation invariant, enforced here: AN OPENER WITH NO CLOSER NEVER
 * PROMOTES. It owns the text to the end (cut-off generation) as a
 * recognized range with a null candidate — even when what was emitted
 * before the cut looks complete (one closed `<parameter>` pair, a
 * balanced JSON object), because the call the model meant to make was
 * still being written. Inside a block, a payload that needed STRUCTURAL
 * repair never yields a candidate either. A partial write or shell
 * command is worse than no call.
 */

import {
  type ScanSource,
  type SyntaxCandidate,
  type SyntaxHit,
  PARAMETER_PAIR_SRC,
  envelopeCandidate,
  executeToolCandidate,
  parseParameterPairs,
  readJsonPayload,
} from "./tool-call-text-interpret.js";
import {
  BRACKET_TOOL_PREFIX,
  BRACKET_WRAPPERS,
  NAMED_CALL_TAGS,
  PARAMETER_TAG,
  RESULT_TAGS,
  WRAPPER_TAGS,
  bracketSource,
  closerRegex,
  closerSource,
  escapeRegex,
  nameAttribute,
  openerRegex,
  openerSource,
} from "./tool-call-text-tags.js";

// ----------------------------------------------------------------- helpers

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

interface Closer { index: number; end: number }

/** First match of a global regex at or after `from`. */
function execFrom(re: RegExp, s: string, from: number): Closer | null {
  re.lastIndex = from;
  const m = re.exec(s);
  return m ? { index: m.index, end: m.index + m[0].length } : null;
}

/** JSON payload at `p` that must end inside the body: `obj` null when it
 *  is truncated, over-cap, or runs past the closer. */
function bodyJson(src: ScanSource, p: number, bodyEnd: number): Record<string, unknown> | null {
  const payload = readJsonPayload(src, p);
  return payload.end <= bodyEnd ? payload.obj : null;
}

// ---------------------------------------------------------------- scanners

/**
 * `<function=NAME>` / `<function name="NAME">` / `<invoke name="NAME">` —
 * name on the tag; payload is a JSON object or `<parameter>` pairs. A bare
 * `<invoke>` with no name attribute is prose about tags, not a call. Scans
 * only openers inside [from, to) so a wrapper can delegate its body; a
 * child's closer must sit before `to`.
 */
export function scanNamedTags(src: ScanSource, hits: SyntaxHit[], from = 0, to = src.text.length): void {
  const s = src.text;
  const re = openerRegex(NAMED_CALL_TAGS);
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null && m.index < to) {
    const tag = m[1].toLowerCase();
    const name = nameAttribute(m[2]);
    if (!name) continue;
    const p = skipWs(s, re.lastIndex);
    const found = execFrom(closerRegex([tag]), s, p);
    const cm = found && found.end <= to ? found : null;
    if (!cm) { // cut off before the closer — recognized, never a candidate
      hits.push({ start: m.index, end: to, candidate: null });
      re.lastIndex = to;
      continue;
    }
    let argsObj: Record<string, unknown> | null = null;
    if (s[p] === "{") argsObj = bodyJson(src, p, cm.index);
    else {
      const body = s.slice(p, cm.index);
      const pairs = parseParameterPairs(body);
      if (pairs.count > 0) argsObj = pairs.args;
      else if (body.trim() === "") argsObj = {};
      // else: unstructured body — recognized, no candidate
    }
    hits.push({ start: m.index, end: cm.end, candidate: argsObj ? { name, argsJson: JSON.stringify(argsObj) } : null });
    re.lastIndex = cm.end;
  }
}

/** Interpret a closed wrapper body that neither starts with JSON nor holds
 *  named child tags: `<parameter>` pairs, the `<execute_tool>` name-line
 *  grammar, a JSON envelope after some preamble, or an empty body with the
 *  name on the opener. */
function wrapperBodyCandidate(src: ScanSource, tag: string, p: number, bodyEnd: number, nameAttr: string | null): SyntaxCandidate | null {
  const body = src.text.slice(p, bodyEnd);
  const pairs = parseParameterPairs(body);
  if (pairs.count > 0) {
    return nameAttr ? { name: nameAttr, argsJson: JSON.stringify(pairs.args) } : envelopeCandidate(pairs.args);
  }
  const inner = body.trim();
  if (tag === "execute_tool") {
    const named = executeToolCandidate(inner);
    if (named) return named;
  }
  const brace = body.indexOf("{");
  if (brace !== -1) {
    const obj = bodyJson(src, p + brace, bodyEnd);
    return obj ? envelopeCandidate(obj) : null;
  }
  return inner === "" && nameAttr ? { name: nameAttr, argsJson: "{}" } : null;
}

const RESULT_TAG_SET: ReadonlySet<string> = new Set(RESULT_TAGS);

const WRAPPER_OPENER_RE_SRC =
  `${openerSource(WRAPPER_TAGS)}|(${BRACKET_WRAPPERS.map((b) => bracketSource(b.open)).join("|")})`;

/**
 * Block wrappers — every WRAPPER_TAG plus the bracket wrappers. The body
 * is a JSON envelope, named child tags (`<function_calls><invoke …>`),
 * `<parameter>` pairs (name on the opener or in a `name` pair), or the
 * `<execute_tool>` name-line grammar. The wrapper is part of the leak:
 * with named children the first child stretches back over the opener and
 * the last forward over the closer, one candidate per child. No closer:
 * the opener owns the text to the end and nothing inside promotes.
 */
export function scanWrapperTags(src: ScanSource, hits: SyntaxHit[]): void {
  const s = src.text;
  const re = new RegExp(WRAPPER_OPENER_RE_SRC, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const bracketText = m[3];
    const bracket = bracketText
      ? BRACKET_WRAPPERS.find((b) => new RegExp(`^${bracketSource(b.open)}$`, "i").test(bracketText))
      : undefined;
    const tag = bracket ? bracket.open : m[1].toLowerCase();
    const closerSrc = bracket ? bracketSource(bracket.close) : closerSource([tag]);
    const p = skipWs(s, re.lastIndex);
    const cm = execFrom(new RegExp(closerSrc, "gi"), s, p);
    if (!cm) { // cut off before the closer — the whole tail is leak, none of it a call
      hits.push({ start: m.index, end: s.length, candidate: null });
      re.lastIndex = s.length;
      continue;
    }
    let candidate: SyntaxCandidate | null = null;
    if (s[p] === "{") {
      const obj = bodyJson(src, p, cm.index);
      candidate = obj ? envelopeCandidate(obj) : null;
    } else {
      const inner: SyntaxHit[] = [];
      if (!bracket) scanNamedTags(src, inner, p, cm.index);
      if (inner.length > 0) {
        inner[0].start = m.index;
        inner[inner.length - 1].end = cm.end;
        if (RESULT_TAG_SET.has(tag)) for (const h of inner) h.candidate = null;
        hits.push(...inner);
        re.lastIndex = cm.end;
        continue;
      }
      candidate = wrapperBodyCandidate(src, tag, p, cm.index, nameAttribute(m[2]));
    }
    if (RESULT_TAG_SET.has(tag)) candidate = null;
    hits.push({ start: m.index, end: cm.end, candidate });
    re.lastIndex = cm.end;
  }
}

/** `[NAME]{json}` / `[tool:NAME]{json}` with an optional `[/NAME]` closer.
 *  The weakest marker — a hit requires a parseable payload so bracketed
 *  prose ("[note] {see below}") never registers, and the prefix-less
 *  `[NAME]` form additionally demands an EXACT tool-name match at
 *  promotion (`- [read] {"path": …} is the shape` must not fuzz its way to
 *  a real read). */
export function scanBracketForms(src: ScanSource, hits: SyntaxHit[]): void {
  const s = src.text;
  const re = new RegExp(String.raw`\[(${escapeRegex(BRACKET_TOOL_PREFIX)}\s*:\s*)?([A-Za-z][\w.\-]{0,200})\]`, "gi");
  const wrappers = new Set(BRACKET_WRAPPERS.map((b) => b.open.toUpperCase()));
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const name = m[2];
    const weak = !m[1];
    if (weak && wrappers.has(name.toUpperCase())) continue; // envelope wrapper — scanWrapperTags owns it
    const p = skipWs(s, re.lastIndex);
    if (s[p] !== "{") continue;
    const payload = readJsonPayload(src, p);
    if (!payload.obj) continue;
    const closer = new RegExp(`^\\s*\\[/${escapeRegex(name)}\\]`, "i").exec(s.slice(payload.end));
    const e = payload.end + (closer ? closer[0].length : 0);
    const candidate: SyntaxCandidate = { name, argsJson: JSON.stringify(payload.obj) };
    if (weak) candidate.exactNameOnly = true;
    hits.push({ start: m.index, end: e, candidate });
    re.lastIndex = e;
  }
}

/** Channel-marker leak: `<|channel|>… to=NAME <|message|>{json}` with an
 *  optional trailing `<|call|>`. Router prefixes (`functions.NAME`) are
 *  left on the name — the resolution ladder strips them. */
export function scanChannelMarkers(src: ScanSource, hits: SyntaxHit[]): void {
  const s = src.text;
  const re = /<\|channel\|>((?:(?!<\|message\|>)[\s\S]){0,300}?)<\|message\|>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const to = /\bto\s*=\s*([\w.\-]+)/.exec(m[1]);
    if (!to) continue; // channel leak without a recipient — not a tool call
    const p = skipWs(s, re.lastIndex);
    if (s[p] !== "{") continue;
    const payload = readJsonPayload(src, p);
    const call = /^\s*<\|call\|>/.exec(s.slice(payload.end));
    const e = payload.end + (call ? call[0].length : 0);
    hits.push({ start: m.index, end: e, candidate: payload.obj ? { name: to[1], argsJson: JSON.stringify(payload.obj) } : null });
    re.lastIndex = e;
  }
}

const LONE_CLOSER_RE_SRC =
  `${closerSource([...WRAPPER_TAGS, ...NAMED_CALL_TAGS, PARAMETER_TAG])}|${BRACKET_WRAPPERS.map((b) => bracketSource(b.close)).join("|")}`;

/**
 * Lone closers and orphan `<parameter>` pairs: tag-only ranges with no
 * candidate. Closers consumed by a block above start inside that block's
 * range, so overlap resolution drops them; only the strays survive.
 */
export function scanStrayFragments(src: ScanSource, hits: SyntaxHit[]): void {
  for (const source of [LONE_CLOSER_RE_SRC, PARAMETER_PAIR_SRC]) {
    const re = new RegExp(source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(src.text)) !== null) {
      hits.push({ start: m.index, end: m.index + m[0].length, candidate: null });
    }
  }
}
