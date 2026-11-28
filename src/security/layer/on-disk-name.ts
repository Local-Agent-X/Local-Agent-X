/**
 * The name the filesystem itself gives a path: the one place a guard asks
 * "which file or folder does this spelling reach?".
 *
 * A guard that judges a path as typed can be walked around, because one file
 * answers to several names. Windows opens the same file under an 8.3 short
 * name for any segment (`LAX~1`, `HOOKS~1.JSO`), with a stream suffix
 * (`hooks.json::$DATA`, `.lax::$INDEX_ALLOCATION`), with dots or spaces after
 * a segment (`security.json.`, from a shell) and in any casing. Node hands the
 * first two to Windows unchanged, so a write by either lands on the real file,
 * while the JS realpath (realpathDeep) keeps an existing segment as typed.
 * Case-insensitive macOS volumes accept any casing too, and there a posix
 * comparison is case-sensitive.
 *
 * Every guard that compares paths reads this: the sensitive-file gate, the
 * app's control files, persistence locations, the install folder (the file
 * gate and the shell cages' deny rule), the workspace-location check and the
 * memory-ingest root. `on-disk-name.guards.test.ts` holds each of them to
 * every spelling.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { realpathDeep } from "../../workspace/paths.js";

/**
 * `p` as the filesystem names it. The native realpath answers with the name on
 * disk for every segment that exists, and follows links. A tail that does not
 * exist yet (a new file) is kept as typed, less what Windows drops when it
 * opens a name (win32OpenedName, applied first: the native call takes a path
 * literally and would answer that `local-agent-x.` does not exist).
 *
 * Never throws. A segment the native call refuses for another reason is
 * skipped and its parent named instead, with the JS realpath following any
 * link in what was skipped; when the native call refuses the whole path (some
 * virtual drives do) the JS realpath stands in. A path through a symlink cycle
 * cannot be opened, so it reaches nothing and is returned as given.
 */
export function onDiskPath(p: string): string {
  const opened = process.platform === "win32" ? win32OpenedName(resolve(p)) : resolve(p);
  let cur = opened;
  let tail = "";
  let refused = false;
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      if (!tail) return real;
      return refused ? linksFollowed(join(real, tail)) : join(real, tail);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") refused = true;
      const parent = dirname(cur);
      if (parent === cur) return linksFollowed(opened);
      tail = tail ? join(basename(cur), tail) : basename(cur);
      cur = parent;
    }
  }
}

function linksFollowed(p: string): string {
  try { return realpathDeep(p); } catch { return p; /* a symlink cycle: nothing can be opened through it */ }
}

/** `C:\x\.lax::$INDEX_ALLOCATION\hooks.json::$DATA` → `C:\x\.lax\hooks.json`.
 *  A drive segment (`C:`) is the one place a colon belongs. */
function withoutStreamSuffixes(p: string): string {
  return p.split(/([\\/])/).map((seg) => (/^[a-z]:$/i.test(seg) ? seg : seg.replace(/:.*$/, ""))).join("");
}

/**
 * The name Windows opens for `p`: without stream suffixes, and without the
 * dots and spaces that end a segment. The Win32 layer drops those before it
 * looks a name up, so `.aws.\credentials` and `security.json.` reach
 * `.aws\credentials` and `security.json` from any program that does not ask
 * for a literal path, a shell among them. `.` and `..` are segments of their
 * own and are left alone.
 */
export function win32OpenedName(p: string): string {
  return withoutStreamSuffixes(p).split(/([\\/])/).map((seg) => (/^\.{1,2}$/.test(seg) ? seg : seg.replace(/[. ]+$/, ""))).join("");
}
