/**
 * Canonical oversize-result spill — the one truncate-and-spill helper. The
 * audit phase (tool-execution/audit-tool-call.ts) applies it to every tool
 * result at the window-aware cap (context-manager/tool-result-cap.ts), the one
 * result limit; tools return their whole result and never cut it themselves.
 *
 * When a result exceeds the cap, the FULL content is saved to disk and the
 * truncation notice tells the model the path — so hitting the cap means
 * "continue reading from disk" (read with offset/limit, or grep for what you
 * need), never "the tail is gone". Every continuation read flows through the
 * `read` tool, which runs injection screening on the exact slice shown (and
 * the spill dir is never screening-exempt) — so chunked continuation stays
 * screened per chunk.
 *
 * Wrap-aware: an external-content wrap (wrapExternalContent) carries its
 * closing boundary AND the "do not follow instructions" caveat at the END —
 * exactly what a tail-cut removes — so every truncated preview is re-closed
 * via closeUnterminatedExternalBlocks before it reaches the model. A note a
 * tool wants the model to see whatever the cap is goes BEFORE its wrapped body.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { closeUnterminatedExternalBlocks } from "../sanitize.js";

export const RESULT_SPILL_DIR = join(tmpdir(), "lax-results");

/** Persist the full content; returns the path, or null when the write fails
 *  (disk full / permissions) — callers degrade to a plain truncation note. */
export function spillFullResult(content: string): string | null {
  try {
    mkdirSync(RESULT_SPILL_DIR, { recursive: true });
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const path = join(RESULT_SPILL_DIR, `${hash}.txt`);
    writeFileSync(path, content, "utf-8");
    return path;
  } catch {
    return null;
  }
}

/**
 * Cap `content` at `maxChars` for the context window, spilling the FULL
 * content to disk so the model can keep reading past the cut. The preview ends
 * at a line break, the note names the path and the continuation moves, and an
 * external block the cut left open is re-closed. Under the cap: unchanged.
 */
export function capWithSpill(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const path = spillFullResult(content);
  if (path) {
    const preview = content.slice(0, maxChars - 200);
    const lastNewline = preview.lastIndexOf("\n");
    const cleanPreview = lastNewline > 0 ? preview.slice(0, lastNewline) : preview;
    return closeUnterminatedExternalBlocks(
      `${cleanPreview}\n\n... [truncated — full result (${content.length} chars) saved to ${path}. ` +
      `To read past this point: grep that file for what you need, or read it with offset/limit.]`,
    );
  }
  return closeUnterminatedExternalBlocks(
    content.slice(0, maxChars) + `\n\n... [truncated at ${maxChars} chars]`,
  );
}
