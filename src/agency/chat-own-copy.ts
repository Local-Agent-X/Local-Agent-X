/**
 * A chat's own copy of its project (ADR 0007 §6): a git worktree of the
 * project's repo on the chat's own branch, so two chats on one project stop
 * writing the same files. The first chat keeps the folder; any other can move
 * to a copy, work there, and merge back when the user says so.
 *
 * - `startOwnCopy` cuts the worktree from the repo's current commit. A chat
 *   that already changed files in the shared folder is refused: those changes
 *   are uncommitted there and would be left behind.
 * - While a chat has a copy, its project folder IS the copy
 *   (session/project-folder.ts asks `ownCopyFolder`), its writes are allowed
 *   there and fenced off the parent repo (`anchorOwnCopy`).
 * - `mergeOwnCopy` commits the copy, then checks before touching anything that
 *   the merge can land: the project folder has no uncommitted tracked changes
 *   on the base branch, and git can merge without a conflict. Only then does
 *   it run the shared merge (worktree-lifecycle.ts `mergeWorktree`), which
 *   removes a worktree whose merge it could not finish; a chat's copy must
 *   outlive a merge that cannot land yet.
 * - `leaveOwnCopy` drops the copy and keeps its branch when it has unmerged work.
 *
 * The binding is kept in `<lax dir>/session-worktrees.json`, so the copy
 * outlives a restart; the worktree is re-adopted by name on first use
 * (`createNamedWorktree`'s recovery).
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { createJsonStore } from "../util/json-store.js";
import type { SecurityLayer } from "../security/index.js";
import { activeWorktrees, git } from "./worktree-core.js";
import { cleanupWorktree, createNamedWorktree, mergeWorktree } from "./worktree-lifecycle.js";
import { holdersOfSession } from "./work-claims.js";

export interface OwnCopy {
  sessionId: string;
  /** The worktree's registry name and its branch. */
  name: string;
  branch: string;
  repoRoot: string;
  baseBranch: string;
  /** The project folder inside the repo ("" when it is the repo root). */
  subdir: string;
  /** The worktree's root. */
  path: string;
  startedAt: string;
}

interface CopyFile extends Record<string, unknown> { copies: Record<string, OwnCopy> }

let fileOverride: string | null = null;
function store() {
  return createJsonStore<CopyFile>(fileOverride ?? join(getLaxDir(), "session-worktrees.json"), { defaults: () => ({ copies: {} }) });
}

function nameFor(sessionId: string): string {
  return `chat-${createHash("sha256").update(sessionId).digest("hex").slice(0, 12)}`;
}

export function ownCopyOf(sessionId: string): OwnCopy | null {
  return store().load().copies[sessionId] ?? null;
}

/** Re-adopt the worktree after a restart; true when it is registered. */
function ensureRegistered(copy: OwnCopy): boolean {
  if (activeWorktrees.has(copy.name)) return true;
  return createNamedWorktree(copy.name, copy.branch, copy.repoRoot, copy.sessionId) !== null;
}

/** The folder a chat with a copy works in, or null when it has none (or its
 *  worktree is gone from disk, in which case the binding is dropped). */
export function ownCopyFolder(sessionId: string): string | null {
  const copy = ownCopyOf(sessionId);
  if (!copy) return null;
  if (!existsSync(copy.path)) {
    store().mutate((d) => { delete d.copies[sessionId]; });
    return null;
  }
  ensureRegistered(copy);
  return copy.subdir ? join(copy.path, copy.subdir) : copy.path;
}

export type StartResult = { ok: true; copy: OwnCopy } | { ok: false; error: string };

/** Give `sessionId` its own copy of the repo `projectFolder` is in. */
export function startOwnCopy(sessionId: string, projectFolder: string): StartResult {
  if (ownCopyOf(sessionId)) return { ok: false, error: "This chat already works in its own copy." };
  let repoRoot: string;
  try {
    repoRoot = git(["rev-parse", "--show-toplevel"], projectFolder);
  } catch {
    return { ok: false, error: "This project is not a git repository, so it cannot be copied per chat." };
  }
  const changedHere = holdersOfSession(sessionId)
    .flatMap((h) => h.claims.filter((c) => c.source === "written" && samePath(h.checkout, repoRoot)).map((c) => c.path));
  if (changedHere.length > 0) {
    return { ok: false, error: `This chat already changed ${changedHere.length} file(s) in the shared folder (${changedHere.slice(0, 3).join(", ")}${changedHere.length > 3 ? ", …" : ""}). They are uncommitted there and would be left behind: commit them first, or start a new chat in its own copy.` };
  }
  const name = nameFor(sessionId);
  const made = createNamedWorktree(name, `chat/${name.slice("chat-".length)}`, repoRoot, sessionId);
  if (!made) return { ok: false, error: "Could not create the copy (see the server log): too many worktrees are open, or git refused." };
  const copy: OwnCopy = {
    sessionId, name, branch: made.branch, repoRoot: resolve(repoRoot), baseBranch: made.baseBranch,
    subdir: relative(realOf(repoRoot), realOf(projectFolder)).replace(/\\/g, "/"),
    path: made.path, startedAt: new Date().toISOString(),
  };
  store().mutate((d) => { d.copies[sessionId] = copy; });
  return { ok: true, copy };
}

function realOf(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => realOf(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

export interface MergeBackResult { merged: boolean; files: number; error?: string; overlapNote?: string }

/** Why the copy cannot merge right now, or null when it can. Touches nothing. */
function cannotMergeYet(copy: OwnCopy): string | null {
  const onBase = git(["rev-parse", "--abbrev-ref", "HEAD"], copy.repoRoot) === copy.baseBranch;
  if (onBase && git(["status", "--porcelain", "--untracked-files=no"], copy.repoRoot)) {
    return `The project folder has uncommitted changes on ${copy.baseBranch} (another chat's work in progress). Commit them there, then merge this copy.`;
  }
  try {
    git(["merge-tree", "--write-tree", "--name-only", copy.baseBranch, "HEAD"], copy.path);
    return null;
  } catch {
    // merge-tree exits non-zero when the two sides conflict.
    return `This copy conflicts with what is now on ${copy.baseBranch}. In this chat, ask the agent to merge ${copy.baseBranch} into its branch (${copy.branch}) and resolve the conflicts, then merge back.`;
  }
}

/** Merge the chat's copy into the project's branch and end the copy. */
export function mergeOwnCopy(sessionId: string): MergeBackResult {
  const copy = ownCopyOf(sessionId);
  if (!copy) return { merged: false, files: 0, error: "This chat has no copy of its own." };
  if (!existsSync(copy.path) || !ensureRegistered(copy)) return { merged: false, files: 0, error: "The copy's worktree could not be found or re-adopted (see the server log)." };
  try {
    if (git("status --porcelain", copy.path)) {
      git("add -A", copy.path);
      git(["commit", "-m", `Chat copy ${copy.branch}: changes`], copy.path);
    }
    const blocked = cannotMergeYet(copy);
    if (blocked) return { merged: false, files: 0, error: blocked };
  } catch (e) {
    return { merged: false, files: 0, error: (e as Error).message };
  }
  const result = mergeWorktree(copy.name);
  // Merged, or the shared merge removed the worktree on a failure the checks
  // above did not foresee (the branch is kept): either way the copy is over.
  if (result.merged || !existsSync(copy.path)) store().mutate((d) => { delete d.copies[sessionId]; });
  return { merged: result.merged, files: result.files, ...(result.error ? { error: result.error } : {}), ...(result.overlapNote ? { overlapNote: result.overlapNote } : {}) };
}

/** Drop the copy without merging. Its branch is kept when it has commits the
 *  base does not. */
export function leaveOwnCopy(sessionId: string): { left: boolean; branchKept: string | null } {
  const copy = ownCopyOf(sessionId);
  if (!copy) return { left: false, branchKept: null };
  let unmerged = true;
  try {
    if (existsSync(copy.path) && git("status --porcelain", copy.path)) {
      git("add -A", copy.path);
      git(["commit", "-m", `Chat copy ${copy.branch}: changes (left unmerged)`], copy.path);
    }
    git(["merge-base", "--is-ancestor", copy.branch, copy.baseBranch], copy.repoRoot);
    unmerged = false;
  } catch { /* not an ancestor (or git could not say): keep the branch */ }
  if (ensureRegistered(copy)) cleanupWorktree(copy.name);
  store().mutate((d) => { delete d.copies[sessionId]; });
  return { left: true, branchKept: unmerged ? copy.branch : null };
}

/** Let a chat write in its copy and nowhere else in the repo. Idempotent; a
 *  chat without a copy has any earlier fence lifted. */
export function anchorOwnCopy(security: Pick<SecurityLayer, "addAllowedPath" | "removeAllowedPath" | "fenceToWorktree" | "releaseFence">, sessionId: string): void {
  const copy = ownCopyOf(sessionId);
  const anchored = anchors.get(sessionId);
  if (!copy) {
    if (anchored) { security.removeAllowedPath(anchored, sessionId); security.releaseFence(sessionId); anchors.delete(sessionId); }
    return;
  }
  if (anchored === copy.path) return;
  security.addAllowedPath(copy.path, sessionId);
  security.fenceToWorktree(sessionId, { worktree: copy.path, repoRoot: copy.repoRoot });
  anchors.set(sessionId, copy.path);
}
const anchors = new Map<string, string>();

/** Test seam. */
export function _setOwnCopyFileForTest(file: string | null): void {
  fileOverride = file;
  anchors.clear();
}
