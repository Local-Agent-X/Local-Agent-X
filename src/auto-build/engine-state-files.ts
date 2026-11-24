/**
 * The build engine's own files beside a project it builds: this machine's
 * run record, halt history, preflight probes and skeptic scratch. They are
 * about one run on one machine, never part of the project, so they stay out
 * of its commits (git-helpers.ts), out of a chunk's worktree
 * (worktree-local-files.ts) and out of cross-machine sync (sync/mirror.ts).
 *
 * Sync is why there is one list. The workspace push only ever adds, so a run
 * record pushed while a build ran stayed in the sync repo after the build
 * cleared it, and every startup pull wrote it back: label-check's finished
 * build read "running, chunk 10" again a day later (2026-11-24).
 */

/** Gitignore-style patterns: a trailing "/" is a folder, "*" any characters. */
export const ENGINE_STATE_PATTERNS: readonly string[] = [
  ".lax-build-run.json",
  ".lax-build-history.json",
  ".skeptic/",
  ".lax-preflight-*",
  ".primal-orchestrator-state.json",
  ".primal-build-state.json",
];

const MATCHERS = ENGINE_STATE_PATTERNS.map((pattern) => {
  const folder = pattern.endsWith("/");
  const name = folder ? pattern.slice(0, -1) : pattern;
  const body = name.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return { folder, test: new RegExp(`^${body}$`) };
});

/** True when a directory entry named `name` is one of the engine's own files
 *  (or, with `isDirectory`, its folders). */
export function isEngineStateEntry(name: string, isDirectory: boolean): boolean {
  return MATCHERS.some((m) => m.folder === isDirectory && m.test.test(name));
}
