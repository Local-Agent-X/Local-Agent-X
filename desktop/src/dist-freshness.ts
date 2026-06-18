// Single source of truth for "is a compiled dist/ current for its source
// tree?" — server dist (server-process.ts chooses dist vs tsx at spawn,
// reconcile.ts decides a pre-launch rebuild) and desktop dist (reconcile.ts
// decides a rebuild + relaunch). Keeping the check in one place stops those
// callers from drifting into different answers.
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

function distNewerThanSources(distFile: string, srcDir: string): boolean {
  if (!existsSync(distFile)) return false;
  const distMtime = statSync(distFile).mtimeMs;
  const stack = [srcDir];
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

export function serverDistIsFresh(projectRoot: string): boolean {
  return distNewerThanSources(join(projectRoot, "dist", "index.js"), join(projectRoot, "src"));
}

// Desktop (Electron main) counterpart. A gated update pre-builds desktop/dist
// before the restart (update-pipeline.ts), so reconcile can skip the rebuild —
// and the relaunch it forces — when the loaded main process is already current.
export function desktopDistIsFresh(projectRoot: string): boolean {
  return distNewerThanSources(
    join(projectRoot, "desktop", "dist", "main.js"),
    join(projectRoot, "desktop", "src"),
  );
}
