import { resolve, isAbsolute, join, basename } from "node:path";
import { homedir } from "node:os";
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
export function resolveAgentPathFrom(workspace: string, p: string, sessionId?: string): string {
  const upload = mapUploadsRef(p);
  if (upload) return upload;
  // A leading "~" is the user's home, the same as every other path consumer
  // (sql-tools, email-config, http-egress-guard, shell-path-guard). Without
  // this a model passing "~/.zshrc" had it treated as workspace-RELATIVE and
  // glued onto the project root (".../Local Agent X/~/.zshrc") → File not found
  // on the first try, only working after the model re-sent an expanded path.
  // Expanding here, in the ONE resolver both the file tool and the security
  // gate call, means the gate evaluates the SAME real target the tool opens.
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return resolve(homedir(), p.slice(2));
  if (isAbsolute(p)) return resolve(p);
  const workRoot = sessionId ? sessionWorkRoots.get(sessionId) : undefined;
  if (workRoot) return resolve(workRoot, p);
  return resolve(workspace, "..", p);
}

export function resolveAgentPath(p: string, sessionId?: string): string {
  return resolveAgentPathFrom(workspaceRoot(), p, sessionId);
}

// ── Per-session work-root anchor ──
//
// A worker run sanctioned to operate on a project OUTSIDE the data root
// (auto-build chunk workers) registers its project dir here; RELATIVE agent
// paths for that session anchor to the project instead of the project root
// above. Without this, a chunk worker's task says "all paths are relative to
// your project dir" while write("app/layout.tsx") actually landed in
// <Documents>/Local Agent X/app/ (live failure 2026-07-01). Registered and
// cleared by the agent driver (server/handler-events.ts) alongside the
// security layer's session allowed-paths, so the gate and the tool keep
// resolving identically — both call THIS resolver with the same sessionId.
const sessionWorkRoots = new Map<string, string>();

export function setSessionWorkRoot(sessionId: string, root: string): void {
  if (sessionId && root) sessionWorkRoots.set(sessionId, resolve(root));
}

export function clearSessionWorkRoot(sessionId: string): void {
  sessionWorkRoots.delete(sessionId);
}

/** The tool-executor-injected session id from a tool's args, if present.
 *  File tools pass this into resolveAgentPath so a session with a
 *  registered work root gets its relative paths anchored there. */
export function sessionIdOf(args: Record<string, unknown>): string | undefined {
  return typeof args._sessionId === "string" && args._sessionId ? args._sessionId : undefined;
}

// The project root — the parent of the workspace, the SAME anchor relative agent
// paths resolve against (see resolveAgentPathFrom). The default working
// directory for shell-class tools (bash / process_start) when the caller gives
// none: without it they inherited the SERVER process cwd, so a relative command
// like `cat notes.txt` looked in the install dir instead of the project and
// failed until the model retried with an absolute path — while the bash gate
// already ASSUMES relative tokens resolve inside the project. Anchoring here
// makes the runtime match the gate and the file tools.
export function projectRoot(): string {
  return resolve(workspaceRoot(), "..");
}
