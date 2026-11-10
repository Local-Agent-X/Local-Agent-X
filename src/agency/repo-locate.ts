/**
 * Which repo a file belongs to, for coordinating agents that work in parallel
 * (ADR 0007 §1). The coordination space is the repo, not the folder: the main
 * checkout and every worktree of it share one `repoKey` (the git common dir),
 * so an agent in `agent/ab12` and a chat in the main folder see each other.
 *
 * Read from disk, never by running git: a write call asks this for each of its
 * targets, so it must cost a few stats, cached per folder. A folder with no
 * git above it falls back to `fallbackRoot` (the session's project folder)
 * when the file is inside it; anything else is in no coordination space.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface RepoPlace {
  /** The repo's identity: its git common dir (or `dir:<folder>`), real-path,
   *  case-folded on Windows. Equal for every worktree of one repo. */
  repoKey: string;
  /** The checkout the file is in: the main working tree or a worktree. */
  checkout: string;
  /** The file's path inside that checkout, `/`-separated. */
  rel: string;
}

const checkoutCache = new Map<string, { repoKey: string; checkout: string } | null>();
const CACHE_CAP = 2_000;

function realOrSelf(p: string): string {
  try { return realpathSync.native(p); } catch { return p; }
}

function keyOf(p: string): string {
  const real = realOrSelf(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? real.toLowerCase() : real;
}

/** The common dir a `.git` entry points at: itself when a folder; for a
 *  worktree's `.git` file, its gitdir's `commondir`. */
function commonDirOf(dotGit: string): string | null {
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    const gitdir = resolve(dirname(dotGit), m[1].trim());
    const commonFile = join(gitdir, "commondir");
    if (!existsSync(commonFile)) return gitdir;
    return resolve(gitdir, readFileSync(commonFile, "utf8").trim());
  } catch {
    return null; // unreadable .git: not a checkout we can place
  }
}

function checkoutOf(dir: string): { repoKey: string; checkout: string } | null {
  const cached = checkoutCache.get(dir);
  if (cached !== undefined) return cached;
  let found: { repoKey: string; checkout: string } | null = null;
  for (let cur = dir; ; cur = dirname(cur)) {
    const dotGit = join(cur, ".git");
    if (existsSync(dotGit)) {
      const common = commonDirOf(dotGit);
      if (common) found = { repoKey: keyOf(common), checkout: realOrSelf(cur) };
      break;
    }
    if (dirname(cur) === cur) break;
  }
  if (checkoutCache.size >= CACHE_CAP) checkoutCache.clear();
  checkoutCache.set(dir, found);
  return found;
}

function within(root: string, p: string): string | null {
  const rel = relative(root, p);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** Where `absPath` sits for coordination, or null when it is in no repo and
 *  not under `fallbackRoot`. The file need not exist yet. */
export function locateInRepo(absPath: string, fallbackRoot?: string): RepoPlace | null {
  if (!isAbsolute(absPath)) return null;
  const target = resolve(absPath);
  const repo = checkoutOf(dirname(target));
  if (repo) {
    const rel = within(repo.checkout, realOrSelf(dirname(target))) ?? "";
    const name = target.slice(dirname(target).length + 1);
    return { ...repo, rel: rel ? `${rel}/${name}` : name };
  }
  if (!fallbackRoot) return null;
  const root = realOrSelf(fallbackRoot);
  const rel = within(root, target);
  return rel ? { repoKey: `dir:${keyOf(root)}`, checkout: root, rel } : null;
}

/** Test seam: forget what folders were placed in. */
export function _resetRepoLocateCacheForTest(): void {
  checkoutCache.clear();
}
