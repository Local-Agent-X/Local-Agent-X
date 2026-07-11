// Single source of truth for "is a compiled dist/ current for its source
// tree?" — server dist (server-process.ts chooses dist vs tsx at spawn,
// reconcile.ts decides a pre-launch rebuild) and desktop dist (reconcile.ts
// decides a rebuild + relaunch). Keeping the check in one place stops those
// callers from drifting into different answers.
//
// Two independent staleness signals, ANDed — dist is fresh only if BOTH agree:
//
//  1. mtime sweep (distNewerThanSources): `npm run build` runs a full
//     (non-incremental) tsc, so after a build dist/index.js is newer than every
//     source file. Metadata-only stat sweep (no content reads for Defender to
//     scan) that short-circuits on the first stale file. Catches uncommitted
//     dev edits instantly — an edited .ts is newer than dist.
//
//  2. git-HEAD stamp (builtRefFresh): `npm run build` records the checked-out
//     commit in <dist>/.builtref. A `git pull` moves HEAD but leaves dist
//     compiled from the OLD commit; the mtime sweep can miss this when a build
//     (or an OTA copy that stamps dist newer than src) left dist mtime ahead of
//     the pulled source. Comparing the stamped commit to the live HEAD catches
//     it deterministically, with no content reads.
//
// The stamp check is scoped to git checkouts (the only place this happens):
// installed apps ship no .git, so builtRefFresh returns true and the mtime
// sweep alone governs — exactly the pre-existing behavior. It is also
// monotonic: it can only ADD staleness (→ the correct tsx/rebuild fallback),
// never call a stale dist fresh. So the worst case it can introduce is one
// slower boot, never running stale code.
//
// OTA caveat the mtime sweep still relies on: copying a pre-built dist over an
// install (copyFile stamps copy-time, and `dist` sorts before `src`) leaves src
// newer than dist and fools the mtime check. The updater touches dist/index.js
// after the copy so a validated, freshly-built dist still reads as fresh.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
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

// Resolve the currently checked-out commit by reading .git directly — no `git`
// subprocess (fast, and works when git isn't on the GUI-launched PATH). Returns
// null when projectRoot is not a git checkout (the installed-app case) or HEAD
// can't be resolved, both of which mean "the stamp check does not apply."
export function currentGitHead(projectRoot: string): string | null {
  const gitDir = join(projectRoot, ".git");
  if (!existsSync(gitDir)) return null;
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
    if (!head.startsWith("ref:")) return head || null; // detached HEAD → raw sha
    const ref = head.slice(4).trim();
    const looseRef = join(gitDir, ref);
    if (existsSync(looseRef)) return readFileSync(looseRef, "utf-8").trim() || null;
    // packed-refs fallback (loose ref file absent after gc/clone)
    const packed = join(gitDir, "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf-8").split("\n")) {
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const sp = line.indexOf(" ");
        if (sp > 0 && line.slice(sp + 1).trim() === ref) return line.slice(0, sp).trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

// True unless we can PROVE the dist was built from a different commit than the
// one checked out now. Absent .git or absent stamp → true (defer to mtime), so
// nothing already deployed regresses.
function builtRefFresh(distDir: string, projectRoot: string): boolean {
  const head = currentGitHead(projectRoot);
  if (head === null) return true; // not a git checkout — mtime is authoritative
  const refFile = join(distDir, ".builtref");
  if (!existsSync(refFile)) return true; // unstamped dist — don't regress
  try {
    return readFileSync(refFile, "utf-8").trim() === head;
  } catch {
    return true;
  }
}

export function serverDistIsFresh(projectRoot: string): boolean {
  const distDir = join(projectRoot, "dist");
  return distNewerThanSources(join(distDir, "index.js"), join(projectRoot, "src"))
    && builtRefFresh(distDir, projectRoot);
}

// Desktop (Electron main) counterpart. A gated update pre-builds desktop/dist
// before the restart (update-pipeline.ts), so reconcile can skip the rebuild —
// and the relaunch it forces — when the loaded main process is already current.
export function desktopDistIsFresh(projectRoot: string): boolean {
  const distDir = join(projectRoot, "desktop", "dist");
  return distNewerThanSources(join(distDir, "main.js"), join(projectRoot, "desktop", "src"))
    && builtRefFresh(distDir, projectRoot);
}
