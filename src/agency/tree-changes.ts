/**
 * Which files a session's shell command changed without naming them
 * (ADR 0007 §2): `sed -i`, a code generator, a build step, a formatter. The
 * write targets of a call (tool-execution/write-targets.ts) only cover what
 * the command line names, so these are found after the fact: the checkout's
 * changed set (git's porcelain status, each file with its size and mtime) is
 * compared with what it was the last time this session looked.
 *
 * The first look is the baseline, taken before the session's first shell
 * command runs, so what was already dirty is nobody's claim. Two agents in the
 * SAME checkout can each be credited with a file the other changed between
 * looks; both then hold the claim, which is true of the folder they share.
 *
 * Git only. A folder that is not a repo, or a status that takes too long or is
 * too large, answers nothing and the session keeps the claims its named writes
 * made. Sibling of work-tree-fingerprint.ts, which hashes the same listing for
 * the loop's work check-in.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { composeGitArgs, execGitSync } from "../git-safety.js";

const MAX_ENTRIES = 5_000;
/** A status slower than this is not re-run for ten times as long as it took:
 *  on a huge tree the look must not tax every shell command. */
const SLOW_STATUS_MS = 500;
const SNAPSHOT_CAP = 200;

type Stamps = Map<string, string>;
const snapshots = new Map<string, { at: number; costMs: number; stamps: Stamps }>();

function key(sessionId: string, checkout: string): string {
  return `${sessionId}\0${checkout.replace(/\\/g, "/").toLowerCase()}`;
}

/** A porcelain line's path: the destination of a rename, unquoted. */
function pathOf(line: string): string {
  const raw = line.slice(3);
  const dest = raw.includes(" -> ") ? raw.slice(raw.indexOf(" -> ") + 4) : raw;
  return dest.trim().replace(/^"|"$/g, "");
}

/** Every changed or untracked file in `checkout` with its size and mtime, or
 *  null when git cannot say. */
export function treeStamps(checkout: string): Stamps | null {
  let porcelain: string;
  try {
    porcelain = execGitSync(composeGitArgs(["-C", checkout, "status", "--porcelain", "--untracked-files=all"]), {
      encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const lines = porcelain.split("\n").filter((l) => l.length > 3);
  if (lines.length > MAX_ENTRIES) return null;
  const stamps: Stamps = new Map();
  for (const line of lines) {
    const rel = pathOf(line);
    if (!rel) continue;
    try {
      const st = statSync(join(checkout, rel));
      stamps.set(rel, `${st.size}:${st.mtimeMs}`);
    } catch {
      stamps.set(rel, "gone"); // deleted: still a change this session may have made
    }
  }
  return stamps;
}

function look(k: string, checkout: string): Stamps | null {
  const started = Date.now();
  const stamps = treeStamps(checkout);
  if (!stamps) return null;
  if (snapshots.size >= SNAPSHOT_CAP && !snapshots.has(k)) snapshots.clear();
  snapshots.set(k, { at: Date.now(), costMs: Date.now() - started, stamps });
  return stamps;
}

/** Take the baseline for `sessionId` in `checkout` if it has none. */
export function baselineTree(sessionId: string, checkout: string): void {
  const k = key(sessionId, checkout);
  if (!snapshots.has(k)) look(k, checkout);
}

/** The files that changed in `checkout` since this session last looked,
 *  repo-relative; [] when there is no baseline yet, or the last status was
 *  slow and recent. */
export function changedSinceLastLook(sessionId: string, checkout: string): string[] {
  const k = key(sessionId, checkout);
  const prior = snapshots.get(k);
  if (!prior) return [];
  if (prior.costMs > SLOW_STATUS_MS && Date.now() - prior.at < prior.costMs * 10) return [];
  const stamps = look(k, checkout);
  if (!stamps) return [];
  const changed: string[] = [];
  for (const [rel, stamp] of stamps) if (prior.stamps.get(rel) !== stamp) changed.push(rel);
  return changed;
}

/** Test seam: forget every baseline. */
export function _resetTreeChangesForTest(): void {
  snapshots.clear();
}
