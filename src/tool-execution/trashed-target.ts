/**
 * A delete target that is already in a trash, and the name the user knows it by.
 *
 * The un-named delete floor (unnamed-delete-gate.ts) matches the user's words
 * against a target's path. A file LAX trashed is no longer at that path: the
 * Recycle Bin renames what it holds (`$R6V7H9Q.json`, with a `$I` sidecar
 * naming where it came from) and ~/.lax/trash files its copies by date. The
 * user can only ever name the file they knew, so "delete
 * agentxos-4c218-….json" could not match the `$R` file the shell was told to
 * remove, and the floor refused the delete three times (2026-11-08). The
 * trash journal (trash-journal.ts) and the bin's own sidecar (os-trash.ts)
 * both record the original path, and this module reads them back.
 *
 * A shell delete of a trashed file is also the last copy going: the floor's
 * usual answer to an un-named shell delete, "use delete_file, it goes to the
 * trash", is no route at all for a file already there. The gate marks such
 * a target `permanent`, and the pre-pass asks instead of redirecting.
 */
import { relative, isAbsolute, resolve, join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { recycledOriginalOf } from "../os-trash.js";
import { trashedOriginalOf } from "../trash-journal.js";
import { resolveAgentPath } from "../workspace/paths.js";

export interface TrashedTarget {
  /** The path the file had before it was trashed, when a record names it;
   *  null for a file in a trash folder that nothing journalled. */
  original: string | null;
}

/** True when `abs` lies inside LAX's own trash folder (every tier of it). */
function underLaxTrash(abs: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const rel = relative(fold(join(getLaxDir(), "trash")), fold(abs));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Is `path` (as the call names it; `sessionId` resolves it the way the tool
 *  will) a file sitting in a trash? Null when it is not. */
export function trashedTarget(path: string, sessionId?: string): TrashedTarget | null {
  let abs: string;
  try {
    abs = resolveAgentPath(path, sessionId);
  } catch {
    abs = path; /* unresolvable for the agent: judge the spelling as written */
  }
  const original = trashedOriginalOf(abs) ?? recycledOriginalOf(abs);
  if (original !== null) return { original };
  return underLaxTrash(abs) ? { original: null } : null;
}
