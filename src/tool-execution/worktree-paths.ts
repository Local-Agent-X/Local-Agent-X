import { posix } from "node:path";

const SEARCH_TOOLS = new Set(["glob", "grep", "structural_search"]);

function comparablePath(path: string): string {
  const normalized = posix.normalize(path.replace(/\\/g, "/")).replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isAbsoluteOnAnyPlatform(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path);
}

/**
 * Anchor delegated file tools to their worktree. Search tools fail closed to
 * the worktree root when handed an absolute path outside it, including a path
 * written in the other operating system's syntax.
 */
export function rewritePathForWorktree(
  toolName: string,
  rawPath: string | undefined,
  worktreePath: string,
): string | undefined {
  if (!rawPath) return SEARCH_TOOLS.has(toolName) ? worktreePath : rawPath;
  if (!isAbsoluteOnAnyPlatform(rawPath)) {
    return posix.join(worktreePath.replace(/\\/g, "/"), rawPath).replace(
      /\//g,
      worktreePath.includes("\\") ? "\\" : "/",
    );
  }
  if (!SEARCH_TOOLS.has(toolName)) return rawPath;

  const root = comparablePath(worktreePath);
  const candidate = comparablePath(rawPath);
  return candidate === root || candidate.startsWith(`${root}/`) ? rawPath : worktreePath;
}
