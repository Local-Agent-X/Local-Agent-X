/**
 * The folder a session builds in: its project folder. Every session that
 * builds has one, so the design brief, the write gate and the structure kit
 * key off one anchor instead of a hard-coded workspace path.
 *
 * - A code session's is its project's `workspace` (agent-store/project-store.ts),
 *   an absolute path or one relative to the workspace, binding only when it is
 *   a real directory.
 * - A chat's is bound at its first app write (tools/app-tools/new-app-folder.ts):
 *   the app's folder under workspace/apps/, kept on the session as `folder`,
 *   workspace-relative, so the binding outlives the turn and the process.
 *
 * The folder's path is the session work root (workspace/paths.ts
 * sessionWorkRootOf): relative paths, bash's cwd and glob/grep's default base
 * all start there, and the folder's AGENTS.md reaches the prompt. Like the App
 * IDE's anchor this is an anchor, not a cage: file access is still decided by
 * the file-access gate.
 *
 * Stamped on every turn of the session (the WS router clears the work root of
 * any frame without an appId first, so the anchor never outlives its session),
 * and never for an App IDE session, whose app folder ide-work-root.ts stamps.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { workspacePath } from "../config.js";
import { ProjectStore } from "../agent-store/project-store.js";
import { sessionWorkRootOf, setSessionWorkRoot } from "../workspace/paths.js";
import { sessionModeOf, type ChatMode } from "./mode.js";
import { ownCopyFolder } from "../agency/chat-own-copy.js";

/** A real directory at `named` (absolute, or relative to the workspace), or nothing. */
function realFolder(named: string | undefined): string | undefined {
  const trimmed = named?.trim();
  if (!trimmed) return undefined;
  const dir = isAbsolute(trimmed) ? trimmed : workspacePath(trimmed);
  try {
    return existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    // An unreadable path is no folder to work in; the session keeps the workspace.
    return undefined;
  }
}

/** The folder a code session's project names, when it is a real directory. */
export function codeSessionFolder(projectWorkspace: string | undefined): string | undefined {
  return realFolder(projectWorkspace);
}

/** The folder a chat was bound to (`Session.folder`, workspace-relative), when it still exists. */
export function chatSessionFolder(folder: string | undefined): string | undefined {
  const dir = realFolder(folder);
  // A bound folder is always inside the workspace; anything else is not a binding.
  return dir && workspaceRelative(dir) !== null ? dir : undefined;
}

/** `dir` relative to the workspace, forward-slashed, or null when outside it. */
export function workspaceRelative(dir: string): string | null {
  const rel = relative(workspacePath(), dir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

export interface ProjectFolderSession {
  id: string;
  mode?: ChatMode;
  projectId?: string;
  folder?: string;
}

/** The project folder a session's record names (never its own copy), if any. */
export function sessionProjectFolder(session: ProjectFolderSession): string | undefined {
  if (session.id.startsWith("ide-")) return undefined;
  return sessionModeOf(session) === "code"
    ? codeSessionFolder(session.projectId ? ProjectStore.getInstance().get(session.projectId)?.workspace : undefined)
    : chatSessionFolder(session.folder);
}

/** Anchor a session at its project folder: its own copy of the project when it
 *  has one (agency/chat-own-copy.ts), else the folder itself. Returns the
 *  folder, if any. */
export function stampSessionProjectFolder(session: ProjectFolderSession): string | undefined {
  if (session.id.startsWith("ide-")) return undefined;
  const folder = ownCopyFolder(session.id) ?? sessionProjectFolder(session);
  if (folder) setSessionWorkRoot(session.id, folder);
  return folder;
}

/**
 * Bindings made during a turn, by a tool, before the session record can be
 * written: the turn's end moves each onto its session (`takeBoundFolder`).
 */
const pendingBindings = new Map<string, string>();

/**
 * Bind a session with no project folder yet to `dir`, an app folder inside the
 * workspace. Returns the workspace-relative folder, or null when the session
 * already has a folder (a code session, an App IDE session, a bound chat) or
 * `dir` is outside the workspace.
 */
export function bindSessionFolder(sessionId: string | undefined, dir: string): string | null {
  if (!sessionId || sessionWorkRootOf(sessionId)) return null;
  const rel = workspaceRelative(dir);
  if (!rel) return null;
  setSessionWorkRoot(sessionId, dir);
  pendingBindings.set(sessionId, rel);
  return rel;
}

/** The folder a turn bound its session to, once; nothing when it bound none. */
export function takeBoundFolder(sessionId: string): string | undefined {
  const rel = pendingBindings.get(sessionId);
  pendingBindings.delete(sessionId);
  return rel;
}
