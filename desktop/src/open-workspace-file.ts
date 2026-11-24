// The main-process door from a renderer file link to the OS default handler.
// The paths arriving here come from agent-written chat links or from a renderer
// that may be showing agent-built HTML with the preload bridge. The renderer is
// not a trust boundary, so the checks live here, behind every caller.
//
// A program opens without a prompt: the user would accept one every time, so it
// would only add a click. The checks cost a legitimate link nothing: the handler
// gets a file inside the workspace, and exactly the file the link names rather
// than one that Win32 path parsing substitutes for it.
//
// The workspace is where the server says it is (the "lax:workspace-root"
// message, its workspaceRoot()). It was <projectRoot>/workspace, which is the
// workspace only while a junction to the real one holds; where it did not, every
// click on a workspace file was refused as missing and did nothing (2026-11-23,
// a deck in Documents\Local Agent X\workspace).

import { shell } from "electron";
import { realpathSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";

let workspaceRoot: string | null = null;

/** The server's workspace root, from its boot announcement. Only an absolute
 *  path is taken: the server sends workspaceRoot(), which always is one. */
export function setWorkspaceRoot(path: unknown): void {
  if (typeof path === "string" && isAbsolute(path)) workspaceRoot = resolve(path);
}

/** Win32 path parsing strips a trailing dot or space from every component, so
 *  ShellExecute opens `run.cmd` for `run.cmd.` or `run.cmd `, and `dir\x.pdf`
 *  for `dir.\x.pdf`. Node's fs goes through `\\?\` paths, so the agent can
 *  create those literal names and the existence check finds them, yet a
 *  different file opens. Refused on every platform so the rule has no OS
 *  branch; no legitimate link needs such a name. */
function win32RenamesComponent(rel: string): boolean {
  return rel.split(sep).some((part) => part.endsWith(".") || part.endsWith(" "));
}

const WORKSPACE_PREFIX = /^workspace[/\\]/;

/** Open a workspace file, written `workspace/<path inside the workspace>` (the
 *  renderer's form for a /files/ link), with the OS default handler. Resolves to
 *  "" on success or a reason string, matching shell.openPath. */
export async function openWorkspaceFile(workspacePath: string): Promise<string> {
  if (!workspaceRoot) {
    console.warn(`[desktop] open-file ignored — the server has not said where the workspace is`);
    return "the workspace location is not known yet";
  }
  if (typeof workspacePath !== "string" || !WORKSPACE_PREFIX.test(workspacePath)) {
    console.warn(`[desktop] open-file rejected (not a workspace path): ${JSON.stringify(workspacePath)}`);
    return "rejected: not a workspace file";
  }
  // The path is renderer-supplied, so a `../../` (or absolute) value would
  // otherwise open ANY file on disk. resolve() collapses traversal; relative()
  // confirms the result stays under the workspace.
  const filePath = resolve(workspaceRoot, workspacePath.replace(WORKSPACE_PREFIX, ""));
  const rel = relative(workspaceRoot, filePath);
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    console.warn(`[desktop] open-file rejected (outside the workspace): ${workspacePath}`);
    return "rejected: path outside the workspace";
  }
  if (win32RenamesComponent(rel)) {
    console.warn(`[desktop] open-file rejected (name ends in a dot or space): ${JSON.stringify(workspacePath)}`);
    return "rejected: a name ends in a dot or space";
  }
  // ShellExecute rewrites a name that does not exist as written: it resolves a
  // missing `run` to a sibling `run.cmd` and truncates `run.exe\0.pdf` at the
  // NUL, so a link that reads as a document would run a program. realpath
  // throws for both.
  try {
    realpathSync.native(filePath);
  } catch {
    console.warn(`[desktop] open-file rejected (no such file): ${JSON.stringify(workspacePath)}`);
    return "rejected: no such file";
  }
  console.log(`[desktop] Opening file: ${filePath}`);
  return shell.openPath(filePath);
}
