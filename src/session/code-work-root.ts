/**
 * A code session works in its project's folder (session/mode.ts): the
 * folder's path is the session work root, so relative paths, bash's cwd and
 * glob/grep's default base all start there (workspace/paths.ts
 * sessionWorkRootOf, the seam ide-work-root.ts stamps for App IDE sessions).
 *
 * The folder is the project's `workspace` (agent-store/project-store.ts), an
 * absolute path or one relative to the workspace. It binds only when it is a
 * real directory. Like the App IDE's anchor this is an anchor, not a cage:
 * file access is still decided by the file-access gate.
 *
 * Stamped on every turn of the session (the WS router clears the work root of
 * any frame without an appId first, so the anchor never outlives its session),
 * and never for an App IDE session, whose app folder ide-work-root.ts stamps.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { workspacePath } from "../config.js";
import { ProjectStore } from "../agent-store/project-store.js";
import { setSessionWorkRoot } from "../workspace/paths.js";
import { sessionModeOf, type ChatMode } from "./mode.js";

/** The folder a code session's project names, when it is a real directory. */
export function codeSessionFolder(projectWorkspace: string | undefined): string | undefined {
  const named = projectWorkspace?.trim();
  if (!named) return undefined;
  const dir = isAbsolute(named) ? named : workspacePath(named);
  try {
    return existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined;
  } catch {
    // An unreadable path is no folder to work in; the session keeps the workspace.
    return undefined;
  }
}

/** Anchor a code session at its project's folder. Returns the folder, if any. */
export function stampCodeSessionWorkRoot(session: { id: string; mode?: ChatMode; projectId?: string }): string | undefined {
  if (sessionModeOf(session) !== "code" || session.id.startsWith("ide-") || !session.projectId) return undefined;
  const folder = codeSessionFolder(ProjectStore.getInstance().get(session.projectId)?.workspace);
  if (folder) setSessionWorkRoot(session.id, folder);
  return folder;
}
