/**
 * A `read` result over the per-result budget is cut at a whole line and told
 * where to continue — never spilled.
 *
 * Measured 2026-09-26 (Peter's live session, qwen3.6:27b, 65k window): a
 * 632-line file rendered to ~30 KB, over the ~24–26k-char cap. The generic
 * budgeter spilled it to lax-results/<hash>.txt and cut it mid-file while the
 * header still said lines_shown=632. The model asked for the rest with
 * offset=494; `read` returned the whole file again (files under 1000 lines
 * ignored offset), cut again; it read the spill file with an offset — also under
 * 1000 lines, so whole again, numbered twice, spilled again. Each pass added ~8k
 * tokens until the request overflowed the window twice.
 *
 * The file itself is the source of truth, so there is nothing to spill: show
 * the whole lines that fit, say exactly which, and name the offset that
 * continues. `read` honors that offset (read-write-tools.ts).
 */
import type { ToolResult } from "../types.js";
import { withMetadata } from "../tools/result-helpers.js";

/** Room kept for the continuation note. */
const NOTE_RESERVE = 240;

/** The cut `read` result, or null when the content is not a numbered read
 *  (the generic budgeter handles it). Under budget: returned unchanged. */
export function budgetReadResult(result: ToolResult, maxChars: number): ToolResult | null {
  const content = result.content;
  if (typeof content !== "string" || content.length <= maxChars) return typeof content === "string" ? result : null;
  const total = (result.metadata as { total_lines?: unknown } | undefined)?.total_lines;
  if (typeof total !== "number") return null;
  const cut = content.lastIndexOf("\n", Math.max(0, maxChars - NOTE_RESERVE));
  if (cut <= 0) return null;
  const body = content.slice(0, cut);
  const numbered = body.split("\n").map((l) => /^(\d+)\t/.exec(l)).filter((m): m is RegExpExecArray => m !== null);
  if (numbered.length === 0) return null;
  const first = Number(numbered[0][1]);
  const last = Number(numbered[numbered.length - 1][1]);
  const note = `\n\n[Showing lines ${first}-${last} of ${total} — the rest did not fit in one result. ` +
    `Continue with read offset=${last + 1}. Nothing was saved elsewhere; the file itself is the source.]`;
  return withMetadata({ ...result, content: body + note }, { lines_shown: last - first + 1, truncated: true, next_offset: last + 1 });
}
