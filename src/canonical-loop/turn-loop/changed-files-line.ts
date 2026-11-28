/**
 * The files this request has changed, for the compaction boundary.
 *
 * A summary is the model's only memory of the stretch it covers, and the
 * summarizer may drop or misname a path; the per-step digest re-attaches the
 * open plan and recent tool names but not what was written. This line comes
 * from the file-change records the rewind and review_changes use
 * (autonomy/rollback-rewind.ts planRewind), not from the summary, so it is
 * exact.
 *
 * changedFilesCarry adds what the last few of those files hold, so the model
 * goes on editing them without first reading each one back: a summary that
 * names a file it was halfway through is what made it re-read before every
 * edit. Captured once, when the summary is made (compact-summary-cache.ts
 * keeps it with the summary), so the head stays byte-identical turn to turn.
 */
import { statSync } from "node:fs";
import { planRewind } from "../../autonomy/rollback-rewind.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { evaluateFileAccess, loadFileAccessMode, readValidatedFile } from "../../security/layer/index.js";
import { getRuntimeConfig } from "../../config.js";
import { estimateTokens } from "../../context-manager/token-estimation.js";
import { detectInjection } from "../../sanitize.js";

const MAX_LISTED = 40;
/** How many of the most recently modified changed files come back with their contents. */
export const CARRIED_FILES = 5;
/** A file larger than this comes back as its path only. */
export const CARRIED_FILE_MAX_TOKENS = 5_000;

function changedFiles(opId: string | undefined): { sessionId: string; files: string[] } | null {
  if (!opId) return null;
  const sessionId = getSessionForOp(opId);
  if (!sessionId) return null;
  try {
    const files = planRewind(sessionId, opId)?.files ?? [];
    return files.length > 0 ? { sessionId, files } : null;
  } catch {
    return null; // the change records are evidence, not state: no list beats a failed compaction
  }
}

function listLine(files: string[]): string {
  const shown = files.slice(0, MAX_LISTED).join(", ");
  const more = files.length > MAX_LISTED ? ` (+${files.length - MAX_LISTED} more)` : "";
  return `[Files you have changed in this request: ${shown}${more}. Re-read one before editing it again.]\n`;
}

/** Modified time, or null for a file that is gone (deleted since, or never readable). */
function modifiedAt(path: string): number | null {
  try {
    const s = statSync(path);
    return s.isFile() ? s.mtimeMs : null;
  } catch {
    return null;
  }
}

/** One carried file: its contents, or its path with why they were left out. */
function carriedFile(path: string, sessionId: string): string {
  // The same decision a `read` of this path gets (the gate rollback.ts runs on
  // these change records), then the read sink the file tools use: the
  // canonical inode, its sensitivity check, no symlink followed at the leaf.
  const decision = evaluateFileAccess(getRuntimeConfig().workspace, loadFileAccessMode(), () => false, "read", path, sessionId);
  if (!decision.allowed) return `--- ${path}: not included; read it before editing.\n`;
  let text: string;
  try {
    text = readValidatedFile(decision.canonicalPath ?? path, sessionId).toString("utf-8");
  } catch {
    return `--- ${path}: could not be read now; read it before editing.\n`;
  }
  if (estimateTokens(text) > CARRIED_FILE_MAX_TOKENS) {
    return `--- ${path}: over ${CARRIED_FILE_MAX_TOKENS.toLocaleString("en-US")} tokens, not included; read the part you need.\n`;
  }
  // Text the model wrote can still carry text it copied from elsewhere: a file
  // that looks like it is giving instructions comes back as a path, to be read
  // through `read`, which screens and labels it.
  if (detectInjection(text).length > 0) return `--- ${path}: not included; read it before editing.\n`;
  return `--- ${path}\n${text}${text.endsWith("\n") ? "" : "\n"}`;
}

/**
 * The changed-files line plus the contents of the CARRIED_FILES most recently
 * modified of them, each up to CARRIED_FILE_MAX_TOKENS ("" when the request
 * changed nothing). The contents are as they were at this moment.
 */
export function changedFilesCarry(opId: string | undefined): string {
  const changed = changedFiles(opId);
  if (!changed) return "";
  const recent = changed.files
    .map((path) => ({ path, at: modifiedAt(path) }))
    .filter((f): f is { path: string; at: number } => f.at !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, CARRIED_FILES);
  if (recent.length === 0) return listLine(changed.files);
  const bodies = recent.map((f) => carriedFile(f.path, changed.sessionId)).join("");
  return `${listLine(changed.files)}[The ${recent.length} you changed most recently, as they were when this summary was made:]\n${bodies}[End of changed files.]\n`;
}
