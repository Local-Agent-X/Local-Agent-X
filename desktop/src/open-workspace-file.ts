// The main-process door from a renderer file link to the OS: open a file with
// its default handler, or show it in its folder. The paths arriving here come
// from agent-written chat links or from a renderer that may be showing
// agent-built HTML with the preload bridge. The renderer is not a trust
// boundary, so the checks live here, behind every caller.
//
// A program in the workspace opens without a prompt: the user would accept one
// every time, so it would only add a click. The checks cost a legitimate link
// nothing: the handler gets a file inside the workspace, and exactly the file
// the link names rather than one that Win32 path parsing substitutes for it.
//
// A file outside the workspace (a photo in Pictures, a PDF in Downloads) opens
// only when it is a document or media file in the user's own folders: never a
// program or script, never a hidden folder (.ssh, .lax) or app data. Showing a
// file in its folder runs nothing, so it takes any type in those same places.
//
// The workspace is where the server says it is (the "lax:workspace-root"
// message, its workspaceRoot()). It was <projectRoot>/workspace, which is the
// workspace only while a junction to the real one holds; where it did not, every
// click on a workspace file was refused as missing and did nothing (2026-11-23,
// a deck in Documents\Local Agent X\workspace).

import { shell } from "electron";
import { realpathSync } from "fs";
import { homedir } from "os";
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

/** What a link may open outside the workspace: what the user's own apps show.
 *  The chat links the same types (FILE_EXTS, public/js/shared-md.js). */
const VIEWABLE = /\.(?:docx?|xlsx?|pptx?|pdf|csv|md|markdown|txt|json|png|jpe?g|gif|webp|svg|html|mp4|webm|mov|m4v|mp3|wav|m4a|ogg|zip)$/i;

/** Folders under home a link never reaches: hidden ones (.ssh, .lax, .aws)
 *  and app data, where keys and tokens live. */
const PRIVATE_COMPONENT = /^(?:\..*|AppData|Library)$/i;

type Resolved = { file: string } | { refused: string };

function inside(root: string, path: string): string | null {
  const rel = relative(root, path);
  return rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel) ? null : rel;
}

/** A `workspace/<path>` link as the file it names, or why it is refused. */
function resolveWorkspacePath(workspacePath: string): Resolved {
  if (!workspaceRoot) return { refused: "the workspace location is not known yet" };
  // The path is renderer-supplied, so a `../../` (or absolute) value would
  // otherwise open ANY file on disk. resolve() collapses traversal; relative()
  // confirms the result stays under the workspace.
  const file = resolve(workspaceRoot, workspacePath.replace(WORKSPACE_PREFIX, ""));
  const rel = inside(workspaceRoot, file);
  if (rel === null) return { refused: "rejected: path outside the workspace" };
  if (win32RenamesComponent(rel)) return { refused: "rejected: a name ends in a dot or space" };
  // ShellExecute rewrites a name that does not exist as written: it resolves a
  // missing `run` to a sibling `run.cmd` and truncates `run.exe\0.pdf` at the
  // NUL, so a link that reads as a document would run a program. realpath
  // throws for both.
  try { realpathSync.native(file); } catch { return { refused: "rejected: no such file" }; }
  return { file };
}

/** A full path in the user's own folders, held to `allowed` as written and as
 *  it resolves (a link named x.pdf that is a junction to a program is refused). */
function resolveHomePath(absPath: string, allowed: (path: string) => boolean): Resolved {
  const home = resolve(homedir());
  const file = resolve(absPath);
  const check = (path: string, root: string): string | null => {
    const rel = inside(root, path);
    if (rel === null) return "rejected: not in your user folder";
    if (rel.split(sep).some((part) => PRIVATE_COMPONENT.test(part))) return "rejected: a hidden or app-data folder";
    if (win32RenamesComponent(rel)) return "rejected: a name ends in a dot or space";
    if (!allowed(path)) return "rejected: not a document or media file";
    return null;
  };
  const asWritten = check(file, home);
  if (asWritten) return { refused: asWritten };
  let real: string;
  try { real = realpathSync.native(file); } catch { return { refused: "rejected: no such file" }; }
  // The resolved file is held to the resolved home: realpath writes a short
  // (8.3) name such as RUNNER~1 out in full, so a home given in short form
  // would otherwise read every file in it as outside.
  let realHome = home;
  try { realHome = realpathSync.native(home); } catch { /* no such folder: nothing resolves inside it */ }
  const asResolved = check(real, realHome);
  return asResolved ? { refused: asResolved } : { file: real };
}

/** A link's path, `workspace/<path>` or full, as the file it names. A full path
 *  into the workspace is held to the workspace's rules. */
function resolveLinkedPath(path: unknown, allowedOutside: (path: string) => boolean): Resolved {
  if (typeof path !== "string") return { refused: "rejected: not a file path" };
  if (WORKSPACE_PREFIX.test(path)) return resolveWorkspacePath(path);
  if (!isAbsolute(path)) return { refused: "rejected: not a workspace file" };
  const rel = workspaceRoot ? inside(workspaceRoot, resolve(path)) : null;
  if (rel !== null) return resolveWorkspacePath("workspace/" + rel);
  return resolveHomePath(path, allowedOutside);
}

function warnRefused(action: string, path: unknown, refused: string): string {
  console.warn(`[desktop] ${action} refused (${refused}): ${JSON.stringify(path)}`);
  return refused;
}

/** Open the file a chat link names with the OS default handler: a workspace
 *  file, written `workspace/<path>` (the renderer's form for a /files/ link) or
 *  in full, or a document or media file in the user's own folders. Resolves to
 *  "" on success or a reason string, matching shell.openPath. */
export async function openLinkedFile(path: string): Promise<string> {
  const resolved = resolveLinkedPath(path, (p) => VIEWABLE.test(p));
  if ("refused" in resolved) return warnRefused("open-file", path, resolved.refused);
  console.log(`[desktop] Opening file: ${resolved.file}`);
  return shell.openPath(resolved.file);
}

/** Show the file a chat link names in its folder (Explorer / Finder), selected.
 *  Runs nothing, so any type in the workspace or the user's own folders. */
export function revealLinkedFile(path: string): string {
  const resolved = resolveLinkedPath(path, () => true);
  if ("refused" in resolved) return warnRefused("reveal-file", path, resolved.refused);
  shell.showItemInFolder(resolved.file);
  return "";
}
