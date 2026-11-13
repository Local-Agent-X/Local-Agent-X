/**
 * The files this request has changed, for the compaction boundary.
 *
 * A summary is the model's only memory of the stretch it covers, and the
 * summarizer may drop or misname a path; the per-step digest re-attaches the
 * open plan and recent tool names but not what was written. This line comes
 * from the file-change records the rewind and review_changes use
 * (autonomy/rollback-rewind.ts planRewind), not from the summary, so it is
 * exact. Paths only: the model re-reads a file when it needs its contents.
 */
import { planRewind } from "../../autonomy/rollback-rewind.js";
import { getSessionForOp } from "../../ops/session-bridge.js";

const MAX_LISTED = 40;

/** One line naming the request's changed files, ending in a newline, or "". */
export function changedFilesLine(opId: string | undefined): string {
  if (!opId) return "";
  const sessionId = getSessionForOp(opId);
  if (!sessionId) return "";
  let files: string[];
  try {
    files = planRewind(sessionId, opId)?.files ?? [];
  } catch {
    return ""; // the change records are evidence, not state: no list beats a failed compaction
  }
  if (files.length === 0) return "";
  const shown = files.slice(0, MAX_LISTED).join(", ");
  const more = files.length > MAX_LISTED ? ` (+${files.length - MAX_LISTED} more)` : "";
  return `[Files you have changed in this request: ${shown}${more}. Re-read one before editing it again.]\n`;
}
