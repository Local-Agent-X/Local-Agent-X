/**
 * delete_file on a FOLDER: the whole folder goes to Local Agent X's own trash
 * (kept 30 days) and `restore_file` brings it back. Peter's decision
 * (2026-09-25): recovering a whole folder matters. Before this, a folder could
 * only go through `rm -r` in bash, which is permanent once its card is approved.
 *
 * The folder always goes to the APP trash, never the OS Recycle Bin: Windows
 * can permanently delete an item too large for the bin when confirmations are
 * suppressed, and this tool promises a restore.
 *
 * Asking is not done here. The un-named-delete gate (tool-execution) cards
 * every folder delete, even a folder the user named, because "clean up
 * client-data" names the folder it must not remove; and it refuses a folder
 * delete outright when no one is there to answer. This module only refuses the
 * folders no card can make safe.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ToolResult } from "../types.js";
import { ok, err } from "./result-helpers.js";
import { moveToTrash } from "../safe-delete.js";
import { workspaceRoot } from "../config.js";
import { loadProtectedFiles } from "../config-loader.js";
import { platformRoot } from "../platform-root.js";
import { getLaxDir } from "../lax-data-dir.js";
import { isCatastrophicDeleteTarget } from "../security/layer/catastrophic-paths.js";
import { pathIsWithin } from "../security/layer/file-access.js";
import { realpathDeep } from "../workspace/paths.js";

const COUNT_CAP = 10_000;

/** Files under `dir`, as the card and the result show them ("61", "10000+"). */
export function folderFileCount(dir: string): string {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; }
    for (const name of entries) {
      const abs = join(d, name);
      let isDir = false;
      try { isDir = statSync(abs).isDirectory(); } catch { continue; }
      if (isDir) stack.push(abs);
      else if (++n >= COUNT_CAP) return `${COUNT_CAP}+`;
    }
  }
  return String(n);
}

export interface FolderRoots {
  workspace: string;
  platform: string;
  laxData: string;
  home: string;
  /** Absolute paths of the engine's protected files and folders. */
  protectedPaths: readonly string[];
}

/** Why this folder must not be deleted, or null. Pure over `roots` so the
 *  suites never aim a real delete at a real workspace. */
export function folderDeleteRefusal(dir: string, roots: FolderRoots): string | null {
  const real = realpathDeep(dir);
  const contains = (p: string) => pathIsWithin(real, realpathDeep(p));
  if (contains(roots.workspace)) return "it is the workspace root, or a folder that contains it";
  if (contains(roots.platform)) return "it contains the Local Agent X installation";
  if (contains(roots.laxData)) return "it contains Local Agent X's data folder";
  if (isCatastrophicDeleteTarget(real, roots.home)) return "it is a system folder, a drive root, or the home folder";
  const hit = roots.protectedPaths.find((p) => contains(p));
  if (hit) return `it contains the protected file ${hit}`;
  const apps = join(realpathDeep(roots.workspace), "apps");
  const rel = relative(apps, real);
  if (rel && !rel.startsWith("..") && !rel.includes("/") && !rel.includes("\\") && pathIsWithin(apps, real)) {
    return `it is an app — call app_delete({ id: "${rel}" }) instead, which stops the app's running server first`;
  }
  return null;
}

function liveRoots(): FolderRoots {
  const platform = platformRoot();
  return {
    workspace: workspaceRoot(),
    platform,
    laxData: getLaxDir(),
    home: homedir(),
    protectedPaths: loadProtectedFiles().map((p) => resolve(platform, p)),
  };
}

export async function deleteFolderToTrash(dir: string): Promise<ToolResult> {
  const refusal = folderDeleteRefusal(dir, liveRoots());
  if (refusal) return err(`Refusing to delete the folder ${dir}: ${refusal}. Nothing was deleted.`, { path: dir, isDirectory: true });
  const files = folderFileCount(dir);
  const trashed = await moveToTrash(dir, "delete_file", { appTrashOnly: true });
  if (!trashed) return err(`Nothing was deleted: ${dir} disappeared before it could be moved to the trash.`, { path: dir, isDirectory: true });
  return ok(
    `Deleted the folder ${dir} (${files} file${files === "1" ? "" : "s"}) — moved to the Local Agent X trash, kept 30 days. ` +
    `Restore it with restore_file({ path: "${dir}" }).`,
    { path: dir, isDirectory: true, files },
  );
}
