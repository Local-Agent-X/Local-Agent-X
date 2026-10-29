/**
 * A folder this session's agent made, holding nothing older than itself: its
 * delete loses no one's earlier data. TB2 git-multibranch, 2026-10-29: the
 * agent made `/var/www/gitproject/{main,dev}` with `mkdir -p`, its own git hook
 * checked the pushed branches out into them, and `rm -rf` of both waited on a
 * card twice until the trial timed out. The files were git's, written by a
 * program the agent ran, so no file record covered them.
 *
 * The proof is the disk's, not the record's: every entry under the folder was
 * born after the folder was (a move or a hard link keeps the entry's own birth
 * time, so data brought in from elsewhere fails it) and last modified after it
 * too (a move across filesystems copies, with a new birth time and the old
 * modification time). Data created in the folder since the agent made it does
 * pass. Fail-closed: a link, a mount, an entry that cannot be read, more than
 * the walk cap, or a process whose birth times are not real.
 */
import { lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentFolderBirth } from "../data-lineage/task-artifacts.js";

/** Above this many entries a folder is not walked. */
const ENTRY_CAP = 400;

let realBirthTimes: boolean | undefined;

/** Node reports a real birth time here. Where the kernel's statx is missing,
 *  libuv reports the change time as the birth time, which a chmod moves; a
 *  path changed after it was made shows the two apart only when birth times
 *  are real. Read once from paths that outlive the process. */
function birthTimesReal(): boolean {
  if (realBirthTimes !== undefined) return realBirthTimes;
  const probes = [process.execPath, dirname(process.execPath), tmpdir(), "/etc", "/usr/bin", "/"];
  realBirthTimes = probes.some((p) => {
    try {
      const s = lstatSync(p);
      return s.birthtimeMs > 0 && s.birthtimeMs < s.ctimeMs;
    } catch {
      return false; // not on this OS: another probe decides
    }
  });
  return realBirthTimes;
}

/** Test seam: what the birth-time probe found. */
export function _setBirthTimesRealForTests(real: boolean | undefined): void {
  realBirthTimes = real;
}

/** The folder at `abs` is one `sessionId`'s agent made, and nothing under it
 *  is older than it. */
export function agentMadeFolderHoldsOnlyNew(abs: string, sessionId: string): boolean {
  const born = agentFolderBirth(sessionId, abs);
  if (born === null || !birthTimesReal()) return false;
  let dev: number;
  try { dev = lstatSync(abs).dev; } catch { return false; /* gone or unreadable: not proven */ }
  let seen = 0;
  const walk = (dir: string): boolean => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (++seen > ENTRY_CAP || e.isSymbolicLink()) return false;
      const p = join(dir, e.name);
      const s = lstatSync(p);
      if (s.dev !== dev || !(s.birthtimeMs >= born) || !(s.mtimeMs >= born)) return false;
      if (s.isDirectory() && !walk(p)) return false;
    }
    return true;
  };
  try {
    return walk(abs);
  } catch {
    return false; // an entry that cannot be read is not proven new
  }
}
