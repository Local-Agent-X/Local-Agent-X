// Ground-truth file sizes — the op-end note that contradicts a fabricated line
// count. Split out of build-verify.ts (which sits at the 400-LOC hygiene gate):
// it is NOT part of the build gate's control flow — it fires whether or not the
// model self-verified, keyed on the reply quoting a size — so it belongs beside
// it, not inside it. Re-exported from build-verify.ts so its one consumer
// (terminal-epilogue.ts) keeps a single import site.

import { readFileSync } from "node:fs";
import { opEditedSourcePaths } from "../middlewares/verify-gate.js";
import { projectRoot, resolveAgentPath } from "../../workspace/paths.js";

interface EditedFileSize {
  /** Path as the model would refer to it (relative to the build cwd when possible). */
  display: string;
  /** Line count the way `wc -l` reports it (newline count). */
  lines: number;
}

/** Cap on files enumerated in the confirmation so a wide sweep doesn't flood the
 *  transcript; the truncation is disclosed. */
const MAX_LISTED_FILES = 25;

/**
 * Measure the on-disk line count of each edited file, `wc -l` semantics (newline
 * count) — the exact number the model or the user would get running `wc -l`, so
 * a fabricated size ("this file is 294 lines" when it's 588) is contradicted by
 * the same measure. Deleted / unreadable paths are skipped (a split that removed
 * a file has no size to report).
 */
function measureEditedFiles(editedPaths: readonly string[], cwd: string): EditedFileSize[] {
  const out: EditedFileSize[] = [];
  for (const p of editedPaths) {
    let text: string;
    try {
      text = readFileSync(p, "utf-8");
    } catch {
      continue;
    }
    const lines = text.match(/\n/g)?.length ?? 0;
    const display = p.startsWith(cwd) ? p.slice(cwd.length).replace(/^[/\\]+/, "") : p;
    out.push({ display, lines });
  }
  return out;
}

/** A line-count claim in prose: "294 lines", "530 LOC", "under 400 lines". Cheap
 *  structural trigger — a false positive only adds a (correct) sizes note; a miss
 *  degrades to today's silence. */
const SIZE_CLAIM_RE = /\b\d{2,}\s*(?:lines?|loc)\b/i;

/**
 * Ground-truth file sizes as an authoritative op-end note — the counterpart to
 * the claim-verify guards, which catch a lie about what a TOOL did but not a lie
 * about what a FILE is (its size). When the model's own summary quotes a line
 * count ("AgentController.ts is 294 lines" when it's 588), the harness measures
 * the edited files itself (`wc -l` semantics) and states the real numbers, so a
 * fabricated count can't be the last word. Fires WHETHER OR NOT the model
 * self-verified (unlike the build gate) — it keys on the reply making a size
 * claim, not on the build path. Silent (null) when the reply quoted no size or no
 * edited file is readable, so it adds zero noise to the ~all edits where size was
 * never discussed.
 *
 * `sessionId` is REQUIRED (explicitly passing `undefined` for a session-less op
 * is fine). It is the anchor a work-root'd worker's relative edited paths
 * resolve against; omitting it resolved them to a location that doesn't exist
 * and the note was silently dropped. Optional, a second call site could
 * reintroduce exactly that with no type error.
 */
export function groundTruthSizesNote(opId: string, assistantText: string, sessionId: string | undefined): string | null {
  if (!SIZE_CLAIM_RE.test(assistantText)) return null;
  // Same canonical resolver, and the same session anchor, the file tools used to
  // WRITE these paths. Without the sessionId a worker anchored outside the data
  // root resolved every relative edited path to a location that doesn't exist,
  // readFileSync threw, and the note was silently dropped.
  const paths = opEditedSourcePaths(opId).map((p) => resolveAgentPath(p, sessionId));
  if (paths.length === 0) return null;
  const sizes = measureEditedFiles(paths, projectRoot());
  if (sizes.length === 0) return null;
  const listed = sizes.slice(0, MAX_LISTED_FILES);
  const more = sizes.length - listed.length;
  const rows = listed.map((s) => `  - ${s.display} — ${s.lines} lines`).join("\n");
  return (
    `Ground-truth size of the files edited this task, measured on disk now ` +
    `(matches \`wc -l\`) — trust these over any remembered or estimated line counts:\n` +
    rows +
    (more > 0 ? `\n  - … and ${more} more` : "")
  );
}
