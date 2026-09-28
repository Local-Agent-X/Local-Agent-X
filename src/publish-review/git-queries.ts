/**
 * Read-only git queries the change set is built from. Each returns null (or an
 * empty list) instead of throwing when git says no: an unborn HEAD, a remote
 * with no default branch, a sha that is not in the local object store are all
 * ordinary states a publish can start from.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "./git-exec.js";
import type { ChangedFile, FileDiff } from "./change-set-types.js";

/** Most commits listed per range; the count past it is reported, not listed. */
export const MAX_COMMITS = 200;
/** Diff text kept for the brief (the whole diff is still hashed). */
export const DIFF_KEEP_BYTES = 2 * 1024 * 1024;
/** Untracked files larger than this are listed and hashed by size, not read. */
const UNTRACKED_READ_LIMIT = 256 * 1024;

const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color", "-M"];

async function line(cwd: string, args: string[]): Promise<string | null> {
  const r = await runGit(cwd, args);
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : null;
}

export async function repoRootOf(cwd: string): Promise<{ root: string } | { reason: string }> {
  if (!existsSync(cwd)) return { reason: `the directory ${cwd} does not exist` };
  const r = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (r.missing) return { reason: "git is not installed or not on PATH" };
  const root = r.stdout.trim();
  if (r.code !== 0 || !root) return { reason: `${cwd} is not inside a git repository` };
  return { root };
}

/** Full commit sha for a revision, or null. */
export function commitOf(root: string, rev: string): Promise<string | null> {
  return line(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
}

export function mergeBase(root: string, a: string, b: string): Promise<string | null> {
  return line(root, ["merge-base", a, b]);
}

/** The id of the empty tree in this repository's hash (sha1 or sha256). */
export async function emptyTree(root: string): Promise<string> {
  const r = await runGit(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" });
  return r.stdout.trim() || "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

export function currentBranch(root: string): Promise<string | null> {
  return line(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
}

/** The current branch's upstream (`origin/main`), or null. */
export function upstreamOf(root: string): Promise<string | null> {
  return line(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
}

/** The newest tag reachable from HEAD, skipping the one being released. */
export function previousTag(root: string, releasing?: string): Promise<string | null> {
  return line(root, ["describe", "--tags", "--abbrev=0", ...(releasing ? ["--exclude", releasing] : []), "HEAD"]);
}

/** Which remote a push/compare is about: the first push argument when it
 *  names a configured remote, else the current branch's remote, else origin,
 *  else the only remote. */
export async function pickRemote(root: string, pushArgs: string[] = []): Promise<string | null> {
  const remotes = (await line(root, ["remote"]))?.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) ?? [];
  if (remotes.length === 0) return null;
  const named = pushArgs.find((a) => !a.startsWith("-"));
  if (named && remotes.includes(named)) return named;
  const branch = await currentBranch(root);
  const tracked = branch ? await line(root, ["config", "--get", `branch.${branch}.remote`]) : null;
  if (tracked && remotes.includes(tracked)) return tracked;
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : null;
}

/** The remote's default branch as a local remote-tracking ref, or null. */
export async function remoteDefaultRef(root: string, remote: string | null): Promise<string | null> {
  if (!remote) return null;
  const head = await line(root, ["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`]);
  if (head) return head.replace(/^refs\/remotes\//, "");
  for (const name of ["main", "master"]) {
    if (await commitOf(root, `refs/remotes/${remote}/${name}`)) return `${remote}/${name}`;
  }
  return null;
}

/** Commits in `range` (git rev-list syntax, as separate args), oldest first. */
export async function commitsIn(root: string, range: string[]): Promise<{ commits: Array<{ sha: string; subject: string }>; truncated: boolean }> {
  const r = await runGit(root, ["log", "--format=%H%x09%s", `--max-count=${MAX_COMMITS + 1}`, ...range]);
  if (r.code !== 0) return { commits: [], truncated: false };
  const rows = r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
    const tab = l.indexOf("\t");
    return { sha: l.slice(0, tab), subject: l.slice(tab + 1) };
  });
  return { commits: rows.slice(0, MAX_COMMITS).reverse(), truncated: rows.length > MAX_COMMITS };
}

/** First parent of the oldest commit not yet on any remote — the diff base
 *  for a branch whose remote has no default branch to merge-base against. */
export async function baseBeforeUnpushed(root: string, head: string): Promise<string | null> {
  const oldest = (await line(root, ["rev-list", "--reverse", head, "--not", "--remotes"]))?.split(/\r?\n/)[0];
  if (!oldest) return head;
  return commitOf(root, `${oldest}^`);
}

export interface DiffResult { files: ChangedFile[]; fileDiffs: FileDiff[]; truncated: boolean; sha256: string }

/** `git diff base [head]` — no head means the working tree (tracked files,
 *  staged and unstaged). */
export async function diffBetween(root: string, base: string, head?: string): Promise<DiffResult> {
  const revs = head ? [base, head] : [base];
  const names = await runGit(root, ["diff", ...DIFF_FLAGS, "--name-status", ...revs]);
  const full = await runGit(root, ["diff", ...DIFF_FLAGS, ...revs], { keepBytes: DIFF_KEEP_BYTES });
  const files: ChangedFile[] = names.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
    const parts = l.split("\t");
    return { status: parts[0], path: parts[parts.length - 1] };
  });
  return { files, fileDiffs: splitDiff(full.stdout), truncated: full.truncated, sha256: full.sha256 };
}

/** Split a unified diff into per-file chunks at each `diff --git` header. */
export function splitDiff(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  const starts = [...text.matchAll(/^diff --git /gm)].map((m) => m.index ?? 0);
  for (let i = 0; i < starts.length; i++) {
    const chunk = text.slice(starts[i], starts[i + 1] ?? text.length);
    const path = / b\/(.+)$/m.exec(chunk.split("\n")[0])?.[1] ?? "(unknown)";
    out.push({ path, text: chunk });
  }
  return out;
}

export interface UntrackedResult { files: ChangedFile[]; fileDiffs: FileDiff[]; identity: string }

/** Untracked, non-ignored files: listed, content-hashed, and rendered as new
 *  files for the brief when they are small text files. */
export async function untrackedFiles(root: string): Promise<UntrackedResult> {
  const r = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], { keepBytes: DIFF_KEEP_BYTES });
  const paths = r.stdout.split("\0").filter(Boolean).sort();
  const files: ChangedFile[] = [];
  const fileDiffs: FileDiff[] = [];
  const ids: string[] = [];
  for (const path of paths) {
    files.push({ status: "??", path });
    const abs = join(root, path);
    let size = 0;
    try { size = statSync(abs).size; } catch { ids.push(`${path}:gone`); continue; }
    if (size > UNTRACKED_READ_LIMIT) { ids.push(`${path}:size=${size}`); continue; }
    let body: Buffer;
    try { body = readFileSync(abs); } catch { ids.push(`${path}:unreadable`); continue; }
    ids.push(`${path}:${createHash("sha256").update(body).digest("hex")}`);
    if (body.includes(0)) continue; // binary — listed, not rendered
    const lines = body.toString("utf8").split(/\r?\n/);
    fileDiffs.push({
      path,
      text: `diff --git a/${path} b/${path}\nnew file (untracked)\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`,
    });
  }
  return { files, fileDiffs, identity: ids.join("\n") };
}
