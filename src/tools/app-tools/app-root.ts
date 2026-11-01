/**
 * Which app folder a session's write or design ask is about. One answer for
 * the design brief, the write gate and the structure kit, so a code session's
 * bound folder and a chat's app under workspace/apps/ are the same thing to
 * all three: the session's project folder (session/project-folder.ts).
 *
 * Before this, every one of them was spelled `workspace/apps/<id>`: a code
 * session bound to C:\Users\peter\Unreal asked for the design brief, was
 * answered "DESIGN SYSTEM for workspace/apps/disneyland-adventure/", and built
 * the game there instead of in the folder it was bound to (2026-10-31).
 */
import { readdirSync } from "node:fs";
import { basename } from "node:path";
import { workspacePath } from "../../config.js";
import { sessionWorkRootOf } from "../../workspace/paths.js";

const normalize = (p: string): string => p.replace(/\\/g, "/");

/** True when `filePath` sits under `workspace/apps/<id>/`, any case. */
export function isUnderAppsDir(filePath: string): boolean {
  return normalize(filePath).toLowerCase().includes("/workspace/apps/");
}

export interface AppRootParts {
  /** The app's folder, forward-slashed. */
  root: string;
  /** The file, relative to it. */
  rel: string;
  /** True when the app is one under workspace/apps/, whose preview is served by Local Agent X. */
  workspaceApp: boolean;
}

/** Split an app-file path into its `workspace/apps/<id>` root and the app-
 *  relative remainder. null when the path isn't under an app dir. Case-
 *  insensitive on the anchor to match isUnderAppsDir; separators normalized so
 *  Windows paths resolve too. */
export function workspaceAppRootAndRel(filePath: string): AppRootParts | null {
  const m = normalize(filePath).match(/^(.*\/workspace\/apps\/[^/]+)\/(.+)$/i);
  return m ? { root: m[1], rel: m[2], workspaceApp: true } : null;
}

/** The session's project folder and the file relative to it, when the file is inside it. */
export function boundFolderRootAndRel(filePath: string, sessionId: string | undefined): AppRootParts | null {
  const bound = sessionWorkRootOf(sessionId);
  if (!bound) return null;
  const root = normalize(bound).replace(/\/+$/, "");
  const file = normalize(filePath);
  if (!file.toLowerCase().startsWith(root.toLowerCase() + "/")) return null;
  return { root, rel: file.slice(root.length + 1), workspaceApp: isUnderAppsDir(root) };
}

/** The app a file belongs to: one under workspace/apps/, else the session's project folder. */
export function appRootAndRel(filePath: string, sessionId: string | undefined): AppRootParts | null {
  return workspaceAppRootAndRel(filePath) ?? boundFolderRootAndRel(filePath, sessionId);
}

/** True when the app folder holds no files yet — a missing one counts. */
export function appFolderIsNew(root: string): boolean {
  try {
    return readdirSync(root).length === 0;
  } catch {
    return true;
  }
}

/** The app's id: its folder's name. */
export function appIdOf(root: string): string {
  return basename(normalize(root));
}

/**
 * The folder a design or kit ask names: the session's project folder when it
 * is one outside workspace/apps/ (a code session's), else the named app under
 * workspace/apps/, else the session's project folder. null when neither names one.
 */
export function appRootForSession(app: string | undefined, sessionId: string | undefined): string | null {
  const bound = sessionWorkRootOf(sessionId);
  if (bound && !isUnderAppsDir(bound)) return normalize(bound);
  if (app) return normalize(workspacePath("apps", app));
  return bound ? normalize(bound) : null;
}

/** How the folder is named to the agent: workspace-relative for a workspace app, absolute otherwise. */
export function describeAppRoot(root: string): string {
  const m = normalize(root).match(/\/(workspace\/apps\/[^/]+)$/i);
  return m ? m[1] : normalize(root);
}
