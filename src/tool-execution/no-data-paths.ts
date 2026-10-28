/**
 * Paths whose delete loses nobody's data, proven from what is on disk, never
 * from a name alone: the disposable-delete proofs (disposable-tree-delete.ts)
 * read this for a target that is neither in the temp dir nor absent. TB2,
 * 2026-10-28: each of these carded or was refused as a user's file.
 *
 *  - A symbolic link (`rm /etc/nginx/sites-enabled/default`): rm unlinks the
 *    link and leaves what it points at. Never with a trailing separator,
 *    which reaches through the link.
 *  - A socket or a FIFO (`rm -f qmp.sock`): an endpoint, no bytes stored.
 *  - A pid file (`rm -f qemu.pid`): named `*.pid` and holding only a process
 *    id, which the program writes again when it starts.
 *  - A system cache (`rm -f /var/lib/apt/lists/…InRelease`): under /var/cache,
 *    which the Filesystem Hierarchy Standard defines as data an application
 *    regenerates and whose deletion loses nothing, or apt's downloaded package
 *    lists, which `apt-get update` fetches again.
 *  - Object files (`rm -f *.o`): each `x.o` beside the source it compiles
 *    from, so the build makes it again.
 *  - git's ORIG_HEAD (`rm -f .git/ORIG_HEAD`): a pointer git rewrites on every
 *    reset, merge and rebase, counted only when HEAD's reflog also records the
 *    commit it points at, so nothing is lost with it.
 *
 * Every check reads the real folder a path sits in, so a link in a parent
 * cannot dress a user's folder as /var/cache.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

const CACHE_ROOTS = ["/var/cache", "/var/lib/apt/lists"];
const SOURCE_EXTENSIONS = [".c", ".cc", ".cpp", ".cxx", ".C", ".s", ".S", ".f", ".f90", ".m", ".mm"];
const PID_FILE_MAX_BYTES = 32;
const REFLOG_MAX_BYTES = 16 * 1024 * 1024;

/** `abs` with its folder resolved through every link, or null when it cannot be. */
function realPlace(abs: string): string | null {
  try { return join(realpathSync(dirname(abs)), basename(abs)); } catch { return null; /* unresolvable folder: not placed */ }
}

function underCacheRoot(abs: string): boolean {
  if (process.platform === "win32") return false;
  const real = realPlace(abs);
  return real !== null && CACHE_ROOTS.some((root) => real.startsWith(root + sep));
}

function pidFile(abs: string, stat: Stats): boolean {
  if (!stat.isFile() || !/\.pid$/.test(abs) || stat.size > PID_FILE_MAX_BYTES) return false;
  try { return /^\s*\d+\s*$/.test(readFileSync(abs, "utf8")); } catch { return false; /* unreadable: not proven */ }
}

function objectFile(abs: string, stat: Stats): boolean {
  if (!stat.isFile() || !abs.endsWith(".o")) return false;
  const stem = abs.slice(0, -2);
  return SOURCE_EXTENSIONS.some((ext) => existsSync(stem + ext));
}

function origHead(abs: string, stat: Stats): boolean {
  if (!stat.isFile() || basename(abs) !== "ORIG_HEAD" || basename(dirname(abs)) !== ".git") return false;
  try {
    const sha = /^([0-9a-f]{40}|[0-9a-f]{64})\s*$/.exec(readFileSync(abs, "utf8"))?.[1];
    const reflog = join(dirname(abs), "logs", "HEAD");
    if (!sha || lstatSync(reflog).size > REFLOG_MAX_BYTES) return false;
    return readFileSync(reflog, "utf8").includes(sha);
  } catch {
    return false; /* no reflog, or unreadable: not proven */
  }
}

/** Does deleting the existing file-system entry `abs` (lstat `stat`) lose
 *  nobody's data? `trailingSep`: the target was written with one. */
export function holdsNoData(abs: string, stat: Stats, trailingSep: boolean): boolean {
  if (stat.isSymbolicLink()) return !trailingSep;
  if (stat.isSocket() || stat.isFIFO()) return true;
  if (underCacheRoot(abs)) return true;
  return pidFile(abs, stat) || objectFile(abs, stat) || origHead(abs, stat);
}

/** A glob in the last segment whose every match holds no data: a pattern
 *  under a system cache folder, or one naming only object files
 *  (`*.o`, `parser*.o`) whose matches each have their source beside them.
 *  No match deletes nothing. */
export function globHoldsNoData(abs: string): boolean {
  const pattern = basename(abs);
  if (underCacheRoot(join(dirname(abs), "_"))) return true;
  if (!/^[^/\\[\]?]*\.o$/.test(pattern) || /[*?[]/.test(dirname(abs))) return false;
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  try {
    return readdirSync(dirname(abs)).filter((name) => re.test(name))
      .every((name) => { const p = join(dirname(abs), name); return objectFile(p, lstatSync(p)); });
  } catch {
    return false; /* unreadable folder: not proven */
  }
}
