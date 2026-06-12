// Single source of truth for "is the server's compiled dist/ current for the
// source tree?" — used both by server-process.ts (choose dist vs tsx at spawn)
// and reconcile.ts (decide whether a pre-launch rebuild is needed). Keeping it
// in one place stops those two from drifting into two different answers.
//
// mtime, not content hash: `npm run build` runs a full (non-incremental) tsc,
// so after a build dist/index.js is newer than every source file. The check is
// a metadata-only stat sweep (no content reads for Defender to scan) that
// short-circuits on the first stale file. The instant anyone edits or pulls
// src ahead of dist, this returns false and the caller falls back to source —
// so running code can never silently drift from source.
//
// Caveat the OTA updater must respect: copying a pre-built dist over an install
// (copyFile stamps copy-time, and `dist` sorts before `src`) leaves src newer
// than dist and fools this check. The updater touches dist/index.js after the
// copy so a validated, freshly-built dist still reads as fresh.

import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

export function serverDistIsFresh(projectRoot: string): boolean {
  const distIndex = join(projectRoot, "dist", "index.js");
  if (!existsSync(distIndex)) return false;
  const distMtime = statSync(distIndex).mtimeMs;
  const stack = [join(projectRoot, "src")];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.name.endsWith(".ts")) continue;
      if (statSync(p).mtimeMs > distMtime) return false;
    }
  }
  return true;
}
