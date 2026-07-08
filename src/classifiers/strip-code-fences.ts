/**
 * Canonical markdown code-fence handling for classifier replies.
 *
 * Models wrap structured output (JSON decisions, verdicts, probes) in
 * ```json fences even when the prompt says not to — claude-opus-4-8 does it
 * reliably. Every reply parser needs the same unwrap, and before this module
 * at least five sites hand-rolled it (classifyJson, done-claim-audit,
 * oracle-probe-gen, memory/curate-classifier, memory/reranker) with subtly
 * different regexes. New parsers use THIS helper; don't add another copy.
 *
 * Semantics — returns the payload a parser should work on:
 *   - no fence            → the input, trimmed
 *   - complete fenced block (with or without a language tag), optionally
 *     surrounded by prose → the block's inner content (first block wins)
 *   - unterminated opening fence (truncated reply) → everything after it
 *
 * Extracting the fenced block (instead of globally deleting every ``` token)
 * keeps backticks INSIDE the payload intact — a global strip corrupts e.g.
 * JSON whose "content" string mentions ```json.
 */
export function stripCodeFences(raw: string): string {
  const s = raw.trim();
  // Complete fenced block, optional language tag, tolerate surrounding prose.
  const block = s.match(/```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```/);
  if (block) return block[1].trim();
  // Opening fence never closed (e.g. reply truncated at a length cap) —
  // strip the opener so the payload underneath is still recoverable.
  const opener = s.match(/^```[a-zA-Z0-9_-]*[ \t]*\r?\n?/);
  if (opener) return s.slice(opener[0].length).trim();
  return s;
}
