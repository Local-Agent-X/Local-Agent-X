// Model-OUTPUT text hygiene — the delivery/persist twin of this directory's
// history seam. Neighbors, for orientation:
//  - providers/sanitize.ts — scrubs LAX's OWN control markers from
//    provider-bound HISTORY (text we feed the model);
//  - src/sanitize.ts — wraps/scrubs INBOUND untrusted content (web pages,
//    tool results) before the model sees it.
// This module cleans what the MODEL itself said, at the two points LAX
// consumes it: delivery (TTS / UI render) and persist (transcript write).
// Small local models leak template plumbing into visible replies —
// chat-template special tokens, reasoning tags, tool-call markup hallucinated
// as plain text, stray closing tags, verbatim whole-reply repeats. Incident
// (2026-07, voice): a local small-model reply carried a stray </blockquote>,
// an exact repeat of the entire reply, and a fabricated
// "<execute_tool>\nNone\n</execute_tool>" block — all saved raw to the
// transcript and read aloud raw by TTS.
//
// Pure functions, no I/O, no imports. Pass order matters — later passes see
// what earlier passes produced. In particular the repeat collapse (5) runs
// AFTER junk removal (1-4) so two copies that differed only in junk still
// collapse, and the whitespace tidy (6) runs last, only over changed text:
//   1. leaked chat-template special tokens: <|...|>, fullwidth <｜...｜>,
//      and marker sequences whose routing word travels with its markers
//   2. reasoning tags, incl. unterminated at end-of-text
//   3. hallucinated tool-call markup, whole block incl. payload
//   4. orphan closing tags of HTML block elements
//   5. adjacent verbatim whole-text self-repetition
//   6. whitespace tidy — clean text returns byte-identical, so this only
//      ever smooths gaps a removal created
//
// PRESERVATION INVARIANT: bytes inside fenced code blocks (```...```) and
// inline backtick spans are never edited — a user legitimately discussing
// `<think>` tags must see them. Passes 1-4 match against a "shadow" copy of
// the text with code-span bytes masked out, so nothing inside a code span
// can TRIGGER a rule. A block whose open/close markers sit in prose may
// still be dropped wholesale WITH code it encloses (an unterminated <think>
// owns everything after it) — that is removal of enclosed content, not
// editing code.

export type ModelOutputProfile = "delivery" | "persist";

// ── Code-span segmentation (the preservation mechanism) ─────────────────────

interface Segment { code: boolean; text: string }

// Fenced block: 3+ backticks, optional info string, lazily to the first
// same-length run — or end-of-text, so an unterminated fence (cut-off
// generation) keeps its whole tail as code, the conservative choice.
// Inline: 1-2 backticks to the matching run; a lone unmatched backtick
// stays prose and sanitizes normally.
const CODE_SPAN_RE = /(`{3,})[^`\n]*\n?[\s\S]*?(?:\1|$)|(`{1,2})(?!`)[\s\S]*?\2(?!`)/g;

function segmentCodeSpans(text: string): Segment[] {
  if (!text.includes("`")) return [{ code: false, text }];
  const segs: Segment[] = [];
  let last = 0;
  CODE_SPAN_RE.lastIndex = 0;
  for (let m = CODE_SPAN_RE.exec(text); m !== null; m = CODE_SPAN_RE.exec(text)) {
    if (m.index > last) segs.push({ code: false, text: text.slice(last, m.index) });
    segs.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ code: false, text: text.slice(last) });
  return segs;
}

// Shadow copy for rule matching: identical length, code-span bytes replaced
// with NUL (newlines kept so line-bounded patterns stay aligned). Rules match
// on the shadow; matched ranges are deleted from the REAL text by index.
// Every bounded inner-content class below excludes \x00 so a rule's TRIGGER
// can never stretch across a code span; the unbounded [\s\S] between a paired
// block's markers deliberately can — see the header invariant.
function shadowOf(text: string): string {
  if (!text.includes("`")) return text;
  let shadow = "";
  for (const seg of segmentCodeSpans(text)) {
    shadow += seg.code ? seg.text.replace(/[^\n]/g, "\u0000") : seg.text;
  }
  return shadow;
}

// Delete every shadow-match of `re` from the real text.
function removeMasked(text: string, re: RegExp): string {
  const shadow = shadowOf(text);
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(shadow); m !== null; m = re.exec(shadow)) {
    out += text.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // never spin on an empty match
  }
  return out + text.slice(last);
}

// ── Pass 1: leaked chat-template special tokens ─────────────────────────────
// Local runtimes leak template plumbing verbatim into visible text: stop and
// role tokens like <|im_end|>, and marker SEQUENCES whose routing word must
// go with its markers — removing only the tokens would leave "final" or
// "assistant" stranded in speech. Fullwidth-bar variants (<｜...｜>) come
// from templates built on U+FF5C. Inner length is bounded so a stray "<|" in
// prose can never eat a paragraph. Sequences run before singles.

const BAR = "[|｜]";
// A json-ish payload: a brace blob ending at a line/tag boundary (lazy, so
// nested braces keep extending until the boundary check passes), or a blob
// cut off at end-of-text.
const JSON_TAIL = String.raw`[^\S\n]*(?:\{[\s\S]{0,4000}?\}(?=[^\S\n]*(?:\n|<|\[|$))|\{[\s\S]*$)`;

// Channel header addressed to a tool ("to="): the whole message is plumbing —
// markers, routing word AND payload go.
const CHANNEL_TOOL_RE = new RegExp(
  `<${BAR}channel${BAR}>[^<>\\n\\x00]{0,160}\\bto=[^<>\\n\\x00]{0,160}<${BAR}message${BAR}>(?:${JSON_TAIL})?`,
  "gi",
);
// Plain channel header (e.g. "final"): markers + routing word go, the payload
// after them IS the reply and stays. Templates sometimes emit the routing
// word on its own line, so ONE newline before the closing marker is consumed
// too — a blank line is not, keeping the bound tight (and a code span can
// still never satisfy the marker literals).
const CHANNEL_PAIR_RE = new RegExp(
  `<${BAR}channel${BAR}>[^<>\\n\\x00]{0,160}?\\n?[ \\t]*<${BAR}message${BAR}>`,
  "gi",
);
// Role-header pair: the role word between the tokens is plumbing too.
const HEADER_PAIR_RE = new RegExp(
  `<${BAR}start_header_id${BAR}>[^<>\\n\\x00]{0,60}<${BAR}end_header_id${BAR}>`,
  "gi",
);
// Turn-opener followed by a bare role word ("<|im_start|>assistant").
const ROLE_OPEN_RE = new RegExp(
  `<${BAR}im_start${BAR}>[ \\t]*(?:system|user|assistant|tool)\\b[ \\t]*\\n?`,
  "gi",
);
// Any remaining single special token, e.g. <|im_end|>, <|eot_id|>. Spaces are
// excluded from the inner class on purpose: real leaked tokens are snake_case
// words, while "<| y |>" in prose is more likely someone writing pipe
// operators — those stay.
const SPECIAL_TOKEN_RE = new RegExp(`<${BAR}[^<>\\n|｜\\x00 \\t]{1,60}${BAR}>`, "g");

const SPECIAL_TOKEN_RULES = [CHANNEL_TOOL_RE, CHANNEL_PAIR_RE, HEADER_PAIR_RE, ROLE_OPEN_RE, SPECIAL_TOKEN_RE];

// ── Pass 2: reasoning tags ──────────────────────────────────────────────────
// <think>/<thinking>/<reasoning>/<thought> (the last is a known small-model
// artifact). Tag AND enclosed content go. An opener never closed — cut-off
// generation — swallows to end-of-text. A lone closer with no opener loses
// only the tag: the text before it may well be the real reply, so content
// stays (conservative; destroying a good reply is worse than leaking a
// fragment of reasoning).
const RTAG = "(think|thinking|reasoning|thought)";
const REASONING_RULES = [
  new RegExp(`<\\s*${RTAG}\\s*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, "gi"),
  new RegExp(`<\\s*${RTAG}\\s*>[\\s\\S]*$`, "gi"),
  new RegExp(`<\\s*/\\s*${RTAG}\\s*>`, "gi"),
];

// ── Pass 3: hallucinated tool-call markup ───────────────────────────────────
// Tool-call syntax emitted as plain text instead of a structured call — the
// call never ran, and neither the markup nor its payload is speech. The whole
// block goes, payload included ("<execute_tool>\nNone\n</execute_tool>" from
// the voice incident). Paired first; an unterminated opener owns the tail
// (cut off mid-hallucination); a lone closer loses only the tag, same
// reasoning as pass 2.
const TOOL_TAG = "(execute_tool|tool_calls?|function_calls?|tool_result|invoke|function)";
const TOOL_RULES: RegExp[] = [
  // Paired block, payload and all. Attrs allowed on the opener, so
  // <function=save_note> and <function name="x"> both pair with </function>.
  new RegExp(`<\\s*${TOOL_TAG}\\b[^<>\\n\\x00]*>[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, "gi"),
  // Unterminated at end-of-text. Bare <function>/<invoke> qualify only when
  // paired (rule above): with no attrs and no closer they're likelier
  // someone talking about tags than a leaked call.
  new RegExp(
    `<\\s*(?:(?:execute_tool|tool_calls?|function_calls?|tool_result)\\b[^<>\\n\\x00]*` +
      `|(?:invoke|function)[\\s=][^<>\\n\\x00]*)>[\\s\\S]*$`,
    "gi",
  ),
  // Lone closer: tag only — text before it may be the real reply.
  new RegExp(`<\\s*/\\s*${TOOL_TAG}\\s*>`, "gi"),
  // Bracket forms.
  /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi,
  /\[TOOL_CALL\][\s\S]*$/gi,
  new RegExp(`\\[tool:[^\\]\\n\\x00]{1,80}\\](?:${JSON_TAIL})?`, "gi"),
];

// ── Pass 4: orphan closing tags of HTML block elements ──────────────────────
// The voice incident's stray "</blockquote>". Conservative, left-to-right
// depth matching per tag: a closer is removed only when no earlier unconsumed
// opener exists in the prose (openers inside code spans don't count — they
// are display text, not structure). Balanced markup is untouched.
const ORPHAN_CLOSER_TAGS = ["blockquote", "div", "p"];

function removeOrphanClosers(text: string): string {
  let out = text;
  for (const tag of ORPHAN_CLOSER_TAGS) {
    const shadow = shadowOf(out);
    const re = new RegExp(`<\\s*(/?)\\s*${tag}\\b[^<>\\n\\x00]*>`, "gi");
    const drops: Array<[number, number]> = [];
    let depth = 0;
    for (let m = re.exec(shadow); m !== null; m = re.exec(shadow)) {
      if (m[1] === "") depth++;
      else if (depth > 0) depth--;
      else drops.push([m.index, m.index + m[0].length]);
    }
    if (drops.length > 0) {
      let next = "";
      let last = 0;
      for (const [s, e] of drops) { next += out.slice(last, s); last = e; }
      out = next + out.slice(last);
    }
  }
  return out;
}

// ── Pass 5: adjacent verbatim self-repetition ───────────────────────────────
// Whole-text case only: the reply is exactly (A)(whitespace gap)(A) with A at
// least 80 chars — the observed failure is a model emitting its entire reply
// twice back-to-back. Exact match only, so short repeats (chants, lyric lines
// under 80 chars) never qualify. Iterated max 3 times so 4x/8x pileups fold
// too. Leading AND trailing whitespace are held aside — an earlier pass's
// removal can leave residue whitespace at either edge (a stripped stop token
// before copy one), and it must not defeat the exact A+gap+A match.
const MIN_REPEAT_BLOCK = 80;

function collapseWholeTextRepeat(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i++) {
    const head = /^\s*/.exec(out)![0];
    const tail = /\s*$/.exec(out)![0];
    if (head.length + tail.length >= out.length) return out; // all-whitespace
    const body = out.slice(head.length, out.length - tail.length);
    const collapsed = collapseOnce(body);
    if (collapsed === null) return out;
    out = head + collapsed + tail;
  }
  return out;
}

// body === A + gap + A (gap pure whitespace, up to 64 chars) → A, else null.
function collapseOnce(body: string): string | null {
  const n = body.length;
  for (let gap = 0; gap <= 64 && n - gap >= 2 * MIN_REPEAT_BLOCK; gap++) {
    if ((n - gap) % 2 !== 0) continue;
    const half = (n - gap) / 2;
    if (gap > 0 && body.slice(half, half + gap).trim() !== "") continue;
    if (body.slice(0, half) === body.slice(half + gap)) return body.slice(0, half);
  }
  return null;
}

// ── Pass 6: whitespace tidy ─────────────────────────────────────────────────
// Runs only when an earlier pass removed something — clean text has already
// returned byte-identical by now. Collapses the 3+ newline gaps removals
// leave down to one blank line (prose only: blank runs inside fenced code are
// content), then trims the ends.
function tidyProse(text: string): string {
  let out = "";
  for (const seg of segmentCodeSpans(text)) {
    out += seg.code ? seg.text : seg.text.replace(/\n{3,}/g, "\n\n");
  }
  return out.trim();
}

/**
 * Full hygiene pass over one model reply at a consumption point.
 *
 * `profile` names the point: "delivery" (TTS / UI render) or "persist"
 * (transcript write). The two are IDENTICAL today, deliberately — the
 * parameter exists so every caller already declares which seam it is for the
 * day the profiles diverge (delivery may grow speech-specific normalization;
 * persist may keep more raw shape for audit). Clean text returns
 * byte-identical.
 */
export function sanitizeModelOutput(text: string, profile: ModelOutputProfile): string {
  void profile; // profiles identical today — see doc comment
  if (!text) return text;
  let out = text;
  for (const re of SPECIAL_TOKEN_RULES) out = removeMasked(out, re); // pass 1
  for (const re of REASONING_RULES) out = removeMasked(out, re); // pass 2
  for (const re of TOOL_RULES) out = removeMasked(out, re); // pass 3
  out = removeOrphanClosers(out); // pass 4
  out = collapseWholeTextRepeat(out); // pass 5
  if (out === text) return text;
  return tidyProse(out); // pass 6
}

/**
 * Cheap, stateless per-delta variant for live streaming: special tokens
 * (pass 1) only, and only its payload-free rules. Known limits, by design:
 *  - a token split across two deltas passes through (stateless);
 *  - no code-span preservation (a lone delta is not a parseable document);
 *  - a channel header addressed to a tool loses its markers here but not its
 *    payload.
 * The full pass at delivery/persist governs the final text — this only keeps
 * the worst plumbing off the live render.
 */
export function stripLeakedSpecialTokensStreaming(delta: string): string {
  if (!delta.includes("<")) return delta;
  let out = delta.replace(CHANNEL_PAIR_RE, "");
  out = out.replace(HEADER_PAIR_RE, "");
  out = out.replace(ROLE_OPEN_RE, "");
  return out.replace(SPECIAL_TOKEN_RE, "");
}
