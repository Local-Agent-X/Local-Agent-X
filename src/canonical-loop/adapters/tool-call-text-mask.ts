/**
 * Code-span masking for tool-call text recognition — the ONE preservation
 * mechanism shared by the recognizer (tool-call-text-syntaxes.ts), model
 * output hygiene (providers/output-sanitize.ts) and history rebuild
 * (anthropic-client/parse.ts). A user or model legitimately discussing
 * `<function_calls>` in backticks is talking ABOUT tags, not leaking a
 * call; before this lived here, output-sanitize masked privately and
 * parse.ts did not mask at all, so a backticked mention truncated the
 * assistant's own history entry.
 *
 * Leaf module: no local imports, pure functions.
 */

export interface CodeSegment { code: boolean; text: string }

// Fenced block: 3+ backticks, optional info string, lazily to the first
// same-length run — or end-of-text, so an unterminated fence (cut-off
// generation) keeps its whole tail as code, the conservative choice.
// Inline: 1-2 backticks to the matching run; a lone unmatched backtick
// stays prose and is recognized normally.
const CODE_SPAN_RE = /(`{3,})[^`\n]*\n?[\s\S]*?(?:\1|$)|(`{1,2})(?!`)[\s\S]*?\2(?!`)/g;

/** Split `text` into alternating prose / code segments (concatenation
 *  round-trips to the input byte-for-byte). */
export function segmentCodeSpans(text: string): CodeSegment[] {
  if (!text.includes("`")) return [{ code: false, text }];
  const segs: CodeSegment[] = [];
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

/**
 * Same-length shadow of `text` with every code-span byte replaced by NUL
 * (newlines kept so line-bounded patterns stay aligned). Recognizers match
 * on the shadow and report ranges that index the REAL text 1:1; nothing
 * inside a code span can TRIGGER recognition, while a block whose markers
 * sit in prose may still enclose code it owns.
 */
const NUL = String.fromCharCode(0);

export function maskCodeSpans(text: string): string {
  if (!text.includes("`")) return text;
  let shadow = "";
  for (const seg of segmentCodeSpans(text)) {
    shadow += seg.code ? seg.text.replace(/[^\n]/g, NUL) : seg.text;
  }
  return shadow;
}
