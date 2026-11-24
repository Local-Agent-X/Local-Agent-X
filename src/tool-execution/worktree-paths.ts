import { posix } from "node:path";
import type { ToolResult } from "../types.js";
import { blocked } from "../tools/result-helpers.js";

function comparablePath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/")).replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isAbsoluteOnAnyPlatform(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path);
}

function joinUnder(root: string, rel: string): string {
  return posix.join(root.replace(/\\/g, "/"), rel).replace(/\//g, root.includes("\\") ? "\\" : "/");
}

/** `candidate` relative to `root` ("" for the root itself), or null when it is not under it. */
function under(candidate: string, root: string): string | null {
  const c = comparablePath(candidate), r = comparablePath(root);
  if (c === r) return "";
  return c.startsWith(`${r}/`) ? posix.normalize(candidate.replace(/\\/g, "/")).slice(r.length + 1) : null;
}

/**
 * Anchor a delegated tool's path argument to its worktree. A search root (the
 * path spec's `searchRoot`) is the worktree root when omitted; an absolute one
 * in the checkout the worktree was cut from (`repoRoot`) becomes the same place
 * in the worktree. Any other absolute search root, including one written in the
 * other operating system's syntax, is `null`: the caller refuses the call.
 *
 * It used to become the worktree root, silently, and the search reported "ok"
 * from a folder the model never named: a seal probe's glob of the holdout came
 * back "0 matches" from the worker's own worktree, never refused, so the wall
 * check could not pass and the build stopped (label-check-sol, 2026-11-24).
 */
export function rewritePathForWorktree(
  rawPath: string | undefined,
  worktreePath: string,
  searchRoot = false,
  repoRoot?: string,
): string | undefined | null {
  if (!rawPath) return searchRoot ? worktreePath : rawPath;
  if (!isAbsoluteOnAnyPlatform(rawPath)) return joinUnder(worktreePath, rawPath);
  if (!searchRoot) return rawPath;
  if (under(rawPath, worktreePath) !== null) return rawPath;
  const inRepo = repoRoot ? under(rawPath, repoRoot) : null;
  if (inRepo !== null) return inRepo === "" ? worktreePath : joinUnder(worktreePath, inRepo);
  return null;
}

/** The refusal for a search root `rewritePathForWorktree` returned null for. */
export function searchOutsideWorktree(rawPath: string, worktreePath: string): ToolResult {
  return blocked(
    `Refused: this agent searches only inside its worktree (${worktreePath}); ${rawPath} is outside it, so nothing was searched there.`,
    {
      layer: "sandbox",
      recovery: "Search inside the worktree (a relative path, or none, starts there). To look at one file elsewhere, read it by its path; the security gate decides that read.",
    },
  );
}
