import { resolve, isAbsolute, join, basename } from "node:path";
import { workspaceRoot, uploadsDir } from "../config.js";

// A "/uploads/<file>" reference — the URL form web/mobile attachments carry —
// resolves to the on-disk uploads dir, NOT a drive-root path. basename() pins it
// to the flat uploads dir so "/uploads/../auth.json" can't escape. Matched before
// isAbsolute because "/uploads/x" reads as absolute on Windows.
const UPLOADS_REF = /^[/\\]uploads[/\\](.+)$/;

// Map a "/uploads/<file>" reference to its on-disk path, or null if it isn't
// one. Exported as the SINGLE source of truth for this mapping so the file tool
// (resolveAgentPath) and the SecurityLayer gate (evaluateFileAccess) resolve an
// attachment ref to the SAME path — otherwise the gate checks a root-level
// "/uploads/x" (outside the workspace → denied) while the tool opens the real
// uploads dir, which is both a TOCTOU and a false-deny in workspace/common mode.
export function mapUploadsRef(p: string): string | null {
  const m = UPLOADS_REF.exec(p);
  return m ? join(uploadsDir(), basename(m[1])) : null;
}

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
// The pure resolver, parameterized by the workspace dir whose PARENT is the
// project root. resolveAgentPath (file tools) calls it with config.workspace;
// the SecurityLayer gate (evaluateFileAccess) calls it with its OWN workspace
// arg. Routing both through this ONE function means the gated path is
// byte-for-byte the opened path and the two can never drift — the exact
// split-brain that silently 404'd / denied attachment reads. Do NOT re-inline
// this logic at either callsite.
export function resolveAgentPathFrom(workspace: string, p: string): string {
  const upload = mapUploadsRef(p);
  if (upload) return upload;
  if (isAbsolute(p)) return resolve(p);
  return resolve(workspace, "..", p);
}

export function resolveAgentPath(p: string): string {
  return resolveAgentPathFrom(workspaceRoot(), p);
}
