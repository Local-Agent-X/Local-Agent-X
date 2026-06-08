import { resolve, isAbsolute } from "node:path";
import { workspaceRoot } from "../config.js";

// ── Canonical resolver for AGENT-SUPPLIED file paths ──
//
// Every agent file tool (read / write / edit / delete) and the SecurityLayer
// that gates them MUST turn a raw `path` argument into an absolute path the
// same way, or the path the tool opens differs from the path security checked
// (a resolution TOCTOU). This function is that single source of truth.
//
// Rule: absolute paths pass through untouched; RELATIVE paths anchor to the
// PROJECT ROOT — the parent of the workspace — NOT process.cwd(). Two facts
// make the project-root anchor the correct one:
//
//   • The agent's path convention is workspace-prefixed (e.g.
//     "workspace/apps/<id>/index.html"). Anchoring to the workspace's PARENT
//     makes that land inside the real workspace, wherever it physically lives
//     — even after the packaged app relocates it into ~/Documents.
//   • In dev the workspace is <repo>/workspace, so its parent is the repo root,
//     which is also the process cwd. There this resolver is a literal no-op:
//     every existing relative read (e.g. "package.json", "src/foo.ts") resolves
//     exactly as it did when the base was cwd.
//
// What this removes: the dependency on a <cwd>/workspace → <Documents> junction
// to make cwd-relative agent paths reach the relocated workspace. The anchor is
// derived from config.workspace, so it is correct whether or not that junction
// was ever created.
export function resolveAgentPath(p: string): string {
  if (isAbsolute(p)) return resolve(p);
  return resolve(workspaceRoot(), "..", p);
}
