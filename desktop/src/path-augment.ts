// PATH-merge helpers shared by every desktop spawn site (server spawn,
// node-floor check/recheck, reconcile's npm steps, native rebuild).
//
// Windows regression this module exists to prevent: PATH merging used to
// hardcode ":" (the POSIX delimiter) and only knew macOS augment dirs, so on
// Windows the augments collapsed into one garbage entry and the ONLY node the
// app could ever see was whatever was on the env PATH inherited at launch.
// The in-app Node upgrade installs a portable node under
// %LOCALAPPDATA%\LocalAgentX\node-v* and persists it to the USER registry
// PATH — which a running process never re-reads — so the post-upgrade recheck
// said "node still missing" forever: install succeeds, gate loops. Discovering
// the portable dir directly (portableNodeDirs) and merging with the platform
// delimiter makes the freshly-installed node visible immediately, no relaunch
// or reboot required.
//
// Deliberately dependency-light (fs/path/os only, no electron) so vitest can
// import it directly.
import { existsSync, readdirSync } from "fs";
import { join, delimiter } from "path";
import { homedir } from "os";

/** Prepend `augments` to an existing PATH string using the platform
 *  delimiter, deduplicated, empties dropped. Augments come first so they win
 *  over later shadows. */
export function mergeAugmentedPath(augments: string[], existing: string | undefined): string {
  const parts = (existing || "").split(delimiter);
  return [...augments, ...parts].filter((p, i, a) => p && a.indexOf(p) === i).join(delimiter);
}

/** Where the Windows installer (NodeBootstrap.cs) and the in-app upgrade
 *  (install-common.mjs --upgrade-node) both unpack the portable Node ZIP.
 *  Keep in sync with installNodePortableWin() in scripts/install-common.mjs. */
export function defaultPortableNodeRoot(): string {
  return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "LocalAgentX");
}

/** Portable Node install dirs under `root` (e.g. node-v24.16.0-win-x64),
 *  newest version first, dirs without a node.exe skipped. Empty when the root
 *  doesn't exist — callers just get no augments. */
export function portableNodeDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .map((name) => ({ name, m: /^node-v(\d+)\.(\d+)\.(\d+)-win-(x64|arm64)$/.exec(name) }))
      .filter((e): e is { name: string; m: RegExpExecArray } => !!e.m && existsSync(join(root, e.name, "node.exe")))
      .sort((a, b) =>
        (Number(b.m[1]) - Number(a.m[1])) ||
        (Number(b.m[2]) - Number(a.m[2])) ||
        (Number(b.m[3]) - Number(a.m[3])))
      .map((e) => join(root, e.name));
  } catch {
    return [];
  }
}
