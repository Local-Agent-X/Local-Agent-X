import { relative, isAbsolute } from "node:path";

// ── Containment predicate (the ONE lexical "is `target` inside `root`") ──
//
// path.relative() alone is NOT a containment test on Windows: across drives or
// UNC shares it returns an ABSOLUTE path (e.g. `relative('C:\\ws','D:\\secret')`
// → `'D:\\secret'`, `relative('C:\\ws','\\\\srv\\share\\x')` → the UNC path)
// which does NOT start with '..'. A bare `!rel.startsWith('..')` therefore reads
// a different-drive target as "inside" every root — voiding confinement (a
// cross-drive traversal never trips the outer gate) AND widening every ALLOW set
// (a C:-allowed path treats a D: target as contained). The `isAbsolute(rel)`
// guard closes both, matching what confineToDir / isUserContentPath already do.
// `rel === ''` (target === root) counts as inside.
//
// `pathImpl` defaults to the platform's node:path (win32 on Windows, posix
// elsewhere) — the only reason it is injectable is so the Windows cross-drive
// invariant can be exercised from a POSIX test host via path.win32.
//
// A leaf module so both file-access.ts and install-root.ts (which file-access
// imports) can share it without an import cycle.
export function pathIsWithin(
  root: string,
  target: string,
  pathImpl: Pick<typeof import("node:path"), "relative" | "isAbsolute"> = { relative, isAbsolute },
): boolean {
  const rel = pathImpl.relative(root, target);
  return !rel.startsWith("..") && !pathImpl.isAbsolute(rel);
}
