/**
 * Rewind — put every file a session's agent changed, from one request on,
 * back to how it was before that request. The chat's Undo on a reply.
 *
 * It rewinds a point in time, not one request in isolation: a file this
 * request edited and a later request edited again goes back to its bytes from
 * before THIS request, so undoing an older reply also undoes the later
 * changes to the files (planRewind counts those requests, for the
 * confirmation). Undoing only this request's edit would leave a file the later
 * request built on half-reverted.
 *
 * For each file the EARLIEST capture in the range is the one that holds its
 * bytes from before: a backup is copied back, a file the range created is moved
 * to the trash. A contract whose undo failed keeps its backups and stays
 * restorable; every other contract in the range is spent (rollback.ts).
 */

import { resolve } from "node:path";
import {
  backupBytes, loadRestoredIds, markRestored, readContracts, undoArtifact,
  type RollbackArtifact, type RollbackContract,
} from "./rollback.js";

/** An artifact with bytes to put back or a file to remove. A `final` delete
 *  (a credential file the user named) kept nothing, so a rewind has nothing
 *  to do for it; a `none` was never captured. */
type Undoable = Exclude<RollbackArtifact, { type: "none" } | { type: "final" }>;
const undoable = (a: RollbackArtifact): a is Undoable => a.type !== "none" && a.type !== "final";

interface RewindRange {
  contracts: RollbackContract[];
  /** file key → the capture holding its bytes from before the range */
  firsts: Map<string, { toolCallId: string; artifact: Undoable }>;
  laterRequests: number;
}

const fileKey = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

function rewindRange(sessionId: string, opId: string): RewindRange | null {
  const restored = loadRestoredIds();
  const live = readContracts().filter((c) => c.sessionId === sessionId && !restored.has(c.toolCallId));
  const start = live.findIndex((c) => c.opId === opId);
  if (start < 0) return null;
  const contracts = live.slice(start);
  const firsts = new Map<string, { toolCallId: string; artifact: Undoable }>();
  for (const c of contracts) {
    for (const a of c.artifacts) {
      if (!undoable(a)) continue;
      const key = fileKey(a.original);
      if (!firsts.has(key)) firsts.set(key, { toolCallId: c.toolCallId, artifact: a });
    }
  }
  const laterRequests = new Set(contracts.filter((c) => c.opId !== opId).map((c) => c.opId)).size;
  return { contracts, firsts, laterRequests };
}

export interface RewindPlan {
  /** Files that would be put back or removed. */
  files: string[];
  /** Other requests after this one whose file changes the rewind also undoes. */
  laterRequests: number;
}

/** What a rewind of this request would touch, without touching it. */
export function planRewind(sessionId: string, opId: string): RewindPlan | null {
  const range = rewindRange(sessionId, opId);
  if (!range) return null;
  return { files: [...range.firsts.values()].map((f) => f.artifact.original), laterRequests: range.laterRequests };
}

/** Each file changed from this request on, with what it held before: the bytes a
 *  rewind would put back (the earliest capture's backup), or null for a file the
 *  range created. The agent's review of its own changes (tools/review-changes.ts)
 *  diffs these against the disk. A backup that cannot be read is left out. */
export function changesSinceOp(sessionId: string, opId: string): Array<{ path: string; before: string | null }> {
  const range = rewindRange(sessionId, opId);
  if (!range) return [];
  return [...range.firsts.values()].flatMap(({ toolCallId, artifact }): Array<{ path: string; before: string | null }> => {
    if (artifact.type === "created") return [{ path: artifact.original, before: null }];
    try { return [{ path: artifact.original, before: backupBytes(toolCallId, artifact).toString("utf-8") }]; }
    catch { return []; } // pruned, removed or expired backup: no before to diff against
  });
}

export type RewindResult =
  | { ok: true; restored: string[]; removed: string[]; failed: Array<{ path: string; error: string }> }
  | { ok: false; error: string };

export async function rewindToBeforeOp(sessionId: string, opId: string): Promise<RewindResult> {
  const range = rewindRange(sessionId, opId);
  if (!range) return { ok: false, error: "no file changes from that request are on record (already undone, or older than the undo window)" };
  const restored: string[] = [];
  const removed: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  const failedCalls = new Set<string>();
  for (const { toolCallId, artifact } of range.firsts.values()) {
    const r = await undoArtifact(toolCallId, artifact, sessionId);
    if (!r.ok) {
      failed.push({ path: artifact.original, error: r.error });
      failedCalls.add(toolCallId);
    } else {
      (artifact.type === "created" ? removed : restored).push(artifact.original);
    }
  }
  markRestored(range.contracts.map((c) => c.toolCallId).filter((id) => !failedCalls.has(id)));
  return { ok: true, restored, removed, failed };
}
