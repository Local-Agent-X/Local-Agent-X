/**
 * Tool-call text syntaxes — THE recognizer of leaked tool-call syntax for
 * the whole repo. tool-call-text-extractor.ts orchestrates promotion; this
 * module only RECOGNIZES shapes and reports their exact source ranges.
 * Local/small models leak tool calls into `content` in a zoo of formats
 * beyond bare JSON:
 *
 *   - XML-ish wrapper tags: `<tool_call>{json}</tool_call>`,
 *     `<function_call>…`, `<function_calls><invoke name="NAME">…`,
 *     `<tool_use>…` (JSON or `<parameter>` children), `<function=NAME>…`,
 *     `<function name="NAME">…`, `<invoke name="NAME">…`, and
 *     `<execute_tool>` blocks (name on the first line or inside JSON).
 *     Any tag may carry a namespace prefix (`<atem:function_calls>`,
 *     `</ns:parameter>`) — the 2026-09-08 muse-glimmer incident.
 *   - Bracket markers: `[NAME]{json}` (exact-name only), `[tool:NAME]{json}`,
 *     `[TOOL_REQUEST]{envelope}[END_TOOL_REQUEST]`, `[TOOL_CALL]…[/TOOL_CALL]`,
 *     optional `[/NAME]`.
 *   - Channel-marker leaks: `<|channel|>… to=NAME <|message|>{json}`.
 *   - Fragments: an opener cut off by end-of-text, a lone closer, an
 *     orphan `<parameter>` pair — recognized, never promoted.
 *
 * The tag vocabulary lives in tool-call-text-tags.ts, the scanners in
 * tool-call-text-scanners.ts, payload interpretation in
 * tool-call-text-interpret.ts, code-span masking in tool-call-text-mask.ts.
 * Every scanner reports the EXACT source range consumed plus a
 * {name, argsJson} candidate when the block carries enough to reconstruct
 * a call — or a null candidate when the block is recognizable call syntax
 * with nothing usable inside.
 *
 * Promotion (turning a candidate into a real pending tool call) is the
 * extractor's job. Two invariants ARE enforced at scan time: an opener
 * with no closer never yields a candidate (it owns the text to the end —
 * cut-off generation, however complete the emitted prefix looks), and a
 * payload that needed STRUCTURAL repair (unbalanced braces/brackets, an
 * unterminated string) never does either. A truncated call must not
 * execute: a partial write or shell command is worse than no call.
 *
 * Code spans: findTextToolCallRanges masks backticked code by default —
 * a reply DISCUSSING `<function_calls>` is not leaking one — and reports
 * ranges that index the real text. scanTextToolCallSyntaxes does not by
 * default: the extractor strips fences first and deliberately promotes
 * payloads a model fenced as ```json.
 */

import { MAX_ARGS_CHARS, MAX_TOOL_NAME_CHARS, resolveToolName } from "./tool-call-text-repair.js";
import { type SyntaxCandidate, type SyntaxHit, scanSource } from "./tool-call-text-interpret.js";
import { maskCodeSpans } from "./tool-call-text-mask.js";
import {
  scanBracketForms,
  scanChannelMarkers,
  scanNamedTags,
  scanStrayFragments,
  scanWrapperTags,
} from "./tool-call-text-scanners.js";

export { escapeRegex } from "./tool-call-text-tags.js";
export { isBrowserShorthand, type SyntaxCandidate, type SyntaxHit } from "./tool-call-text-interpret.js";
export { maskCodeSpans } from "./tool-call-text-mask.js";

export interface TextToolCallRange {
  start: number;
  end: number;
  promoted: boolean;
}

export interface ScanOptions {
  /** Recognize on a code-span-masked shadow so backticked mentions never
   *  trigger. Ranges index the real text either way. */
  maskCodeSpans?: boolean;
}

/** Caps gate shared by the extractor's promotion path and range scan. */
export function withinCaps(c: SyntaxCandidate): boolean {
  return c.name.length <= MAX_TOOL_NAME_CHARS && c.argsJson.length <= MAX_ARGS_CHARS;
}

/**
 * The offered tool a candidate names, or null. Marked syntax earns the
 * normalization + edit-distance ladder; a candidate flagged
 * `exactNameOnly` (the bare `[NAME]{json}` form) must match verbatim.
 * ONE rule, shared by the extractor's promotion and the range verdict.
 */
export function resolveCandidateName(c: SyntaxCandidate, validToolNames: Set<string>): string | null {
  if (c.exactNameOnly) return validToolNames.has(c.name) ? c.name : null;
  return resolveToolName(c.name, validToolNames);
}

/**
 * Run every syntax scanner over `text` and return non-overlapping hits in
 * source order (earliest start wins; ties prefer the longer range). A
 * wrapper's children are also found by the standalone named-tag scan;
 * the wrapper-stretched copy starts earlier so it wins and the duplicate
 * is dropped as overlapping. Lone closers consumed by a block start
 * inside its range and vanish the same way.
 */
export function scanTextToolCallSyntaxes(text: string, opts: ScanOptions = {}): SyntaxHit[] {
  if (!text || typeof text !== "string") return [];
  const src = scanSource(opts.maskCodeSpans ? maskCodeSpans(text) : text);
  const hits: SyntaxHit[] = [];
  scanWrapperTags(src, hits);
  scanNamedTags(src, hits);
  scanBracketForms(src, hits);
  scanChannelMarkers(src, hits);
  scanStrayFragments(src, hits);
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
 * verdict is syntax-only). Structurally-truncated payloads, unclosed
 * openers, empty/None blocks, lone closers and orphan parameter pairs
 * never yield candidates, so they always report promoted:false — the same
 * invariant the extractor enforces. Masks code spans unless told not to:
 * this is the scrubbing view, and quoted tags are not leaks.
 */
export function findTextToolCallRanges(
  text: string,
  validToolNames?: Set<string>,
  opts: ScanOptions = {},
): TextToolCallRange[] {
  const hits = scanTextToolCallSyntaxes(text, { maskCodeSpans: opts.maskCodeSpans ?? true });
  return hits.map((h) => ({
    start: h.start,
    end: h.end,
    promoted: h.candidate !== null && withinCaps(h.candidate) &&
      (validToolNames === undefined || resolveCandidateName(h.candidate, validToolNames) !== null),
  }));
}
