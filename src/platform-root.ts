import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Where LAX ITSELF is installed — the tree holding src/ (or dist/) and public/.
//
// NOT derivable from config.workspace: the workspace relocates (packaged app →
// ~/Documents/Local Agent X/workspace; a dev box can junction <repo>/workspace
// at the same target), and `resolve(workspace, "..")` then names the WORKSPACE's
// parent, which is not this codebase. The security gate's platform-source guard
// asked that question of workspace/.. and so protected ~/Documents/Local Agent X
// — a tree with no platform source in it — while the real repo stayed writable.
// An agent overwrote public/css/app.css through the hole (2026-07-15).
//
// workspace/.. remains correct for what it actually answers: where a RELATIVE
// agent path anchors (workspace/paths.ts → resolveAgentPathFrom). That is a
// different question from "what is the platform", and conflating the two is the
// bug. Ask this module the second question and paths.ts the first.
//
// Anchored to this file's own location, which is true wherever the tree is
// installed and under every loader. tsc preserves directory shape, so
// <root>/src/platform-root.ts and <root>/dist/platform-root.js both sit one
// level under the root. import.meta.dirname is undefined under tsx (the
// server's run-from-source path), hence the import.meta.url derivation — via
// fileURLToPath, never url.pathname, which percent-encodes the spaces in
// "Local Agent X" into a path that doesn't exist.
const moduleDir =
  import.meta.dirname ??
  (import.meta.url ? dirname(fileURLToPath(import.meta.url)) : undefined);

// cwd is the last resort, not the answer: it's right only when the server was
// launched from the root. Reaching it means the loader exposed neither anchor.
const ROOT = moduleDir ? resolve(moduleDir, "..") : process.cwd();

/** The root of the LAX install/checkout — the parent of src/, dist/, public/. */
export function platformRoot(): string {
  return ROOT;
}
