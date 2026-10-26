/**
 * Whether an in-place edit of a file this session never `read` still proves it
 * knows the bytes it changes: every `old_string` it carries occurs exactly once
 * in the file as it is now. Such an edit can only land on the text the model
 * quoted — the same uniqueness the edit tools themselves require — so the
 * stale-read guard (run-sandboxed.ts) lets it through. The model had seen the
 * file another way (`cat`, grep, a diff); refusing it cost a round trip each
 * time, 8 times across two ScanProgress sessions (2026-10-25/26).
 *
 * Proves nothing, and the guard still asks for a read: a line-number edit
 * (edit_lines), a `replace_all`, a missing or empty old_string, a quote that
 * occurs twice or not at all, an unreadable file. A file that CHANGED since
 * the session read it is not this question; the guard keeps refusing that.
 */
import { readFileSync } from "node:fs";

function oldStrings(args: Record<string, unknown>): string[] | null {
  if (args.replace_all === true) return null;
  if (typeof args.old_string === "string") return [args.old_string];
  let edits = args.edits;
  if (typeof edits === "string") {
    try { edits = JSON.parse(edits); } catch { return null; }
  }
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const out: string[] = [];
  for (const e of edits) {
    const rec = e as { old_string?: unknown; replace_all?: unknown } | null;
    if (!rec || typeof rec.old_string !== "string" || rec.replace_all === true) return null;
    out.push(rec.old_string);
  }
  return out;
}

function occursOnce(text: string, needle: string): boolean {
  const first = text.indexOf(needle);
  return first !== -1 && text.indexOf(needle, first + 1) === -1;
}

export function editPinsContent(args: Record<string, unknown>, absPath: string): boolean {
  const quotes = oldStrings(args);
  if (!quotes || quotes.some((q) => q.length === 0)) return false;
  let text: string;
  try { text = readFileSync(absPath, "utf-8"); } catch { return false; }
  // Edit tools match across line endings the way the file has them; compare
  // both spellings so a CRLF file is not refused for an LF quote.
  const lf = text.replace(/\r\n/g, "\n");
  return quotes.every((q) => occursOnce(text, q) || occursOnce(lf, q.replace(/\r\n/g, "\n")));
}
