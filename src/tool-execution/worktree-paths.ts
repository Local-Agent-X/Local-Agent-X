import { posix } from "node:path";

function comparablePath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/")).replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isAbsoluteOnAnyPlatform(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path);
}

/**
 * Anchor a delegated tool's path argument to its worktree. A search root (the
 * path spec's `searchRoot`) fails closed to the worktree root when omitted or
 * handed an absolute path outside it, including a path written in the other
 * operating system's syntax.
 */
export function rewritePathForWorktree(
  rawPath: string | undefined,
  worktreePath: string,
  searchRoot = false,
): string | undefined {
  if (!rawPath) return searchRoot ? worktreePath : rawPath;
  if (!isAbsoluteOnAnyPlatform(rawPath)) {
    return posix.join(worktreePath.replace(/\\/g, "/"), rawPath).replace(
      /\//g,
      worktreePath.includes("\\") ? "\\" : "/",
    );
  }
  if (!searchRoot) return rawPath;

  const root = comparablePath(worktreePath);
  const candidate = comparablePath(rawPath);
  return candidate === root || candidate.startsWith(`${root}/`) ? rawPath : worktreePath;
}
