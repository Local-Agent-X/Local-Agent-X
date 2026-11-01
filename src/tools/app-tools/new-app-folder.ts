/**
 * The write that starts an app: the first file in an app folder that was
 * empty or missing. Two things happen on it, so a project the agent writes by
 * hand gets what one built by build_app or a scaffold gets:
 *   - a chat with no project folder is bound to the app's, and works there from
 *     then on (session/project-folder.ts);
 *   - the structure kit lands beside the file (app-scaffold/project-kit.ts),
 *     the way it does wherever a project is created.
 *
 * Measured before the write (`appFolderStartedBy`: the folder is new right
 * now) and acted on after it (`onAppFolderStarted`), so the kit's "never
 * overwrite a file that exists" rule sees the user's file first. A project
 * with no project file yet (a page and its scripts at the root) gets `.` as
 * its source root, so the checks cover what is there.
 */
import { applyProjectKit, type ApplyKitResult } from "../../app-scaffold/project-kit.js";
import { detectProjectKind } from "../../app-scaffold/project-kind.js";
import { bindSessionFolder } from "../../session/project-folder.js";
import { appFolderIsNew, appIdOf, appRootAndRel, describeAppRoot } from "./app-root.js";

/** The app folder `filePath` would start, when that folder holds no files yet; null otherwise. */
export function appFolderStartedBy(filePath: string, sessionId: string | undefined): string | null {
  const parts = appRootAndRel(filePath, sessionId);
  return parts && appFolderIsNew(parts.root) ? parts.root : null;
}

export interface AppFolderStart {
  root: string;
  /** The folder the chat is now bound to, workspace-relative; null when it already had one. */
  bound: string | null;
  kit: ApplyKitResult;
}

/** Bind the chat to the app it just started, and land the structure kit there. */
export function onAppFolderStarted(root: string, sessionId: string | undefined): AppFolderStart {
  const bound = bindSessionFolder(sessionId, root);
  const kind = detectProjectKind(root);
  const kit = applyProjectKit(root, { projectName: appIdOf(root), ...(kind.language === "unknown" ? { sourceRoot: "." } : {}) });
  return { root, bound, kit };
}

/** What the agent is told on the write that started the app. */
export function appStartNote(start: AppFolderStart): string {
  const where = describeAppRoot(start.root);
  return [
    start.bound ? `This chat now works in ${where}/: relative paths and bash start there.` : `Started ${where}/.`,
    start.kit.written.length > 0
      ? `Its structure kit landed beside your file (${start.kit.written.filter((f) => !f.startsWith("scripts/")).join(", ")}, scripts/): ` +
        "AGENTS.md holds the rules for changing it, and `node scripts/check-structure.mjs` runs its checks; run it before you say done."
      : "",
  ].filter(Boolean).join(" ");
}
