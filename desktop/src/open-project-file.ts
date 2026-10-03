// The main-process door from a renderer file link to the OS default handler.
// The paths arriving here come from agent-written chat links or from a renderer
// that may be showing agent-built HTML with the preload bridge. The renderer is
// not a trust boundary, so the checks live here, behind every caller.
//
// A program opens without a prompt: the user would accept one every time, so it
// would only add a click. The checks cost a legitimate link nothing: the handler
// gets a file inside the project, and exactly the file the link names rather
// than one that Win32 path parsing substitutes for it.

import { shell } from "electron";
import { realpathSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";
import { getProjectRoot } from "./config";

/** Win32 path parsing strips a trailing dot or space from every component, so
 *  ShellExecute opens `run.cmd` for `run.cmd.` or `run.cmd `, and `dir\x.pdf`
 *  for `dir.\x.pdf`. Node's fs goes through `\\?\` paths, so the agent can
 *  create those literal names and the existence check finds them, yet a
 *  different file opens. Refused on every platform so the rule has no OS
 *  branch; no legitimate link needs such a name. */
function win32RenamesComponent(rel: string): boolean {
  return rel.split(sep).some((part) => part.endsWith(".") || part.endsWith(" "));
}

/** Open a PROJECT_ROOT-relative path with the OS default handler. Resolves to
 *  "" on success or a reason string, matching shell.openPath. */
export async function openProjectFile(relativePath: string): Promise<string> {
  // Resolve against PROJECT_ROOT, not process.cwd(): a Finder-launched Mac .app
  // has cwd `/`.
  const root = getProjectRoot();
  if (!root) {
    console.warn(`[desktop] open-file ignored — PROJECT_ROOT unresolved`);
    return "PROJECT_ROOT unresolved";
  }
  // `relativePath` is renderer-supplied, so a `../../` (or absolute) value
  // would otherwise open ANY file on disk. resolve() collapses traversal;
  // relative() confirms the result stays under root.
  const filePath = resolve(root, relativePath);
  const rel = relative(root, filePath);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    console.warn(`[desktop] open-file rejected (outside project root): ${relativePath}`);
    return "rejected: path outside project root";
  }
  if (win32RenamesComponent(rel)) {
    console.warn(`[desktop] open-file rejected (name ends in a dot or space): ${JSON.stringify(relativePath)}`);
    return "rejected: a name ends in a dot or space";
  }
  // ShellExecute rewrites a name that does not exist as written: it resolves a
  // missing `run` to a sibling `run.cmd` and truncates `run.exe\0.pdf` at the
  // NUL, so a link that reads as a document would run a program. realpath
  // throws for both.
  try {
    realpathSync.native(filePath);
  } catch {
    console.warn(`[desktop] open-file rejected (no such file): ${JSON.stringify(relativePath)}`);
    return "rejected: no such file";
  }
  console.log(`[desktop] Opening file: ${filePath}`);
  return shell.openPath(filePath);
}
