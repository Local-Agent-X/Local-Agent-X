/**
 * Tool-call text tag vocabulary — the ONE list of tag and marker names
 * that mean "leaked tool-call syntax" anywhere in the repo. Nobody else
 * hard-codes these names: the syntax scanners (tool-call-text-scanners.ts),
 * delivery-time sanitization, the Anthropic text-leak parser and the
 * stream filter all build their patterns from this file, so a shape that
 * one recognizer learns is a shape every recognizer knows.
 *
 * Every tag may carry an optional XML-style namespace prefix
 * (`<atem:function_calls>`, `<ns:invoke name="x">`, `</ns:parameter>`).
 * Incident 2026-09-08 (muse-glimmer:30b): a garbled Anthropic-internal
 * namespace leaked as plain text and no recognizer matched, because each
 * one anchored the bare tag name. The builders here always accept the
 * prefix on openers AND closers.
 *
 * Pure data + tiny regex builders. No I/O, no parsing.
 */

/** Block wrappers. The call's name lives inside (JSON envelope, named
 *  child tags, or `<parameter>` pairs) or on a `name="…"` attribute. */
export const WRAPPER_TAGS = [
  "tool_call",
  "function_call",
  "function_calls",
  "tool_calls",
  "tool_use",
  "execute_tool",
  "tool_result",
] as const;
export type WrapperTag = (typeof WRAPPER_TAGS)[number];

/** Wrappers whose payload is a tool RESULT, never a call: recognized as
 *  leak syntax, never promoted. */
export const RESULT_TAGS: ReadonlyArray<WrapperTag> = ["tool_result"];

/** Named-call tags: the tool name rides on the opener
 *  (`<function=NAME>`, `<function name="NAME">`, `<invoke name="NAME">`). */
export const NAMED_CALL_TAGS = ["function", "invoke"] as const;

/** Argument pair tag: `<parameter name="K">V</parameter>` / `<parameter=K>V</parameter>`. */
export const PARAMETER_TAG = "parameter";

/** Every XML-ish tag in the vocabulary. */
export const ALL_TOOL_TAGS: ReadonlyArray<string> = [...WRAPPER_TAGS, ...NAMED_CALL_TAGS];

/** Bracket wrappers with their closers: `[TOOL_CALL]…[/TOOL_CALL]`,
 *  `[TOOL_REQUEST]…[END_TOOL_REQUEST]`. */
export const BRACKET_WRAPPERS: ReadonlyArray<{ open: string; close: string }> = [
  { open: "TOOL_CALL", close: "/TOOL_CALL" },
  { open: "TOOL_REQUEST", close: "END_TOOL_REQUEST" },
];

/** `[tool:NAME]{json}` — the prefix word before the colon. */
export const BRACKET_TOOL_PREFIX = "tool";

/** Regex fragment: optional namespace prefix before a tag name. */
export const NAMESPACE_PREFIX = String.raw`(?:[A-Za-z][\w.-]*:)?`;

/** Regex fragment: an opener's attribute tail (`=NAME`, ` name="x"`, …).
 *  Anchored on a word boundary so `<function>` cannot match `<functionx>`;
 *  never crosses another angle bracket or a masked code byte. A newline is
 *  allowed (`<invoke\nname="read">` is how some templates wrap attrs) but
 *  the tail is length-bounded so a stray `<function` in prose can never
 *  reach a `>` paragraphs away. */
export const TAG_ATTRS = String.raw`(?:\b[^<>\x00]{0,200})?`;

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `(?:a|b|c)` — longest name first so `function_calls` is tried before
 *  `function_call` and neither steals the other's match. */
export function tagAlternation(tags: ReadonlyArray<string>): string {
  const sorted = [...tags].sort((a, b) => b.length - a.length || a.localeCompare(b));
  return `(?:${sorted.map(escapeRegex).join("|")})`;
}

/** Opener source for any of `tags`, namespace-tolerant. Group 1 = the bare
 *  tag name (prefix stripped), group 2 = the attribute tail (may be empty). */
export function openerSource(tags: ReadonlyArray<string>): string {
  return String.raw`<\s*${NAMESPACE_PREFIX}(${tagAlternation(tags)})(${TAG_ATTRS})>`;
}

/** Closer source for any of `tags`, namespace-tolerant. Group 1 = tag name. */
export function closerSource(tags: ReadonlyArray<string>): string {
  return String.raw`<\s*/\s*${NAMESPACE_PREFIX}(${tagAlternation(tags)})\s*>`;
}

export function openerRegex(tags: ReadonlyArray<string>, flags = "gi"): RegExp {
  return new RegExp(openerSource(tags), flags);
}

export function closerRegex(tags: ReadonlyArray<string>, flags = "gi"): RegExp {
  return new RegExp(closerSource(tags), flags);
}

/** `[MARKER]` bracket source — whitespace-tolerant inside the brackets. */
export function bracketSource(marker: string): string {
  return String.raw`\[\s*${escapeRegex(marker)}\s*\]`;
}

/** Plain, prefix-less substrings of a tag — for cheap `includes` probes
 *  where a regex is overkill. A namespaced leak will NOT match these; use
 *  openerRegex/closerRegex when the prefix matters. */
export function tagSubstrings(tag: string): { opener: string; closer: string } {
  return { opener: `<${tag}>`, closer: `</${tag}>` };
}

const NAME_ATTR_RE = /^(?:\s*=\s*|[\s\S]*?\bname\s*=\s*)["']?([\w.\-]+)/i;

/** Tool name carried on an opener's attribute tail: `=NAME` or `name="NAME"`.
 *  Null for a bare tag — `<invoke>` with no name is someone talking about
 *  tags, not a call. */
export function nameAttribute(attrs: string | undefined): string | null {
  if (!attrs) return null;
  const m = NAME_ATTR_RE.exec(attrs);
  return m ? m[1].trim() : null;
}
