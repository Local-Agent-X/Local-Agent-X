/**
 * The files every chunk of a project edits, merged by rule.
 *
 * A project built with the structure kit asks each chunk to add its module to
 * ARCHITECTURE.md and to regenerate docs/codebase-map.md. Chunks built in
 * parallel therefore ALL edit those two files, whatever their declared
 * footprints, and the second one to merge always conflicted with the first:
 * the build halted with chunks that had passed still unmerged (label-check,
 * 2026-11-22, chunks 4 and 5).
 *
 * Those conflicts carry no decision. So they are settled by rule, and only
 * they are:
 *   - a file each chunk only ADDS to (ARCHITECTURE.md's rows, the build's own
 *     notes in spec/build-state.md) keeps both sides' lines;
 *   - the GENERATED map takes the base's copy and is generated again from the
 *     merged project once the batch is in (regenerateSharedFiles).
 * A conflict in any other file, code above all, is never settled here: the
 * chunk is set aside with its work on its branch (parallel-waves.ts). The
 * wave's re-gate then builds the merged project, and a project's own structure
 * check fails a map or an ARCHITECTURE.md that came out wrong.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { takeBaseCopy, unionMergeConflicted, type MergeConflictResolver } from "../../agency/worktree-merge-conflicts.js";
import { runCaged } from "../../tools/caged-spawn.js";
import { nodeScriptArgv } from "../../tools/program-argv.js";
import { gitAdd, gitCommit } from "../git-helpers.js";

/** Files a chunk only adds lines to. */
const ADD_ONLY_FILES: ReadonlySet<string> = new Set(["ARCHITECTURE.md", "spec/build-state.md"]);
/** The kit's generated map and the script that writes it. */
export const GENERATED_MAP = "docs/codebase-map.md";
export const MAP_SCRIPT = "scripts/codebase-map.mjs";
const REGENERATE_TIMEOUT_MS = 120_000;

const posix = (file: string): string => file.replace(/\\/g, "/");

export interface SharedFileMerge {
  /** Handed to mergeWorktree: settles a merge whose conflicts are all in shared files. */
  resolver: MergeConflictResolver;
  /** Whether a merge took the base's copy of the generated map since the last regenerate. */
  mapIsStale(): boolean;
  /** The map was generated again. */
  mapRegenerated(): void;
}

export function createSharedFileMerge(): SharedFileMerge {
  let stale = false;
  return {
    resolver(worktreePath, conflicted) {
      const files = conflicted.map(posix);
      const generated = (file: string): boolean => file === GENERATED_MAP && existsSync(join(worktreePath, MAP_SCRIPT));
      // All or nothing: one conflicted file outside the rule leaves the whole merge alone.
      if (!files.every((file) => ADD_ONLY_FILES.has(file) || generated(file))) return false;
      for (const file of files) {
        if (generated(file)) { takeBaseCopy(worktreePath, file); stale = true; }
        else unionMergeConflicted(worktreePath, file);
      }
      return true;
    },
    mapIsStale: () => stale,
    mapRegenerated: () => { stale = false; },
  };
}

/**
 * Generate the map again from the merged project and commit it. The script is
 * the project's own copy of the kit's, so it runs in the shell cage like the
 * project's build. Returns what happened in a line for the build's log; a
 * failure is not fatal here, the wave's re-gate judges the merged project.
 */
export async function regenerateSharedFiles(projectDir: string, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  try {
    const outcome = await runCaged(nodeScriptArgv([MAP_SCRIPT]), {
      cwd: projectDir, env: { FORCE_COLOR: "0", CI: "1" }, signal, timeoutMs: REGENERATE_TIMEOUT_MS,
      detached: process.platform !== "win32",
    });
    if (outcome.kind !== "exit") return { ok: false, detail: `the map script did not finish (${outcome.kind})` };
    if (outcome.code !== 0) return { ok: false, detail: `the map script exited ${outcome.code ?? "without a code"}` };
    await gitAdd(projectDir, GENERATED_MAP);
    const commit = await gitCommit(projectDir, "regenerate the codebase map after merging parallel chunks");
    return { ok: true, detail: commit.committed ? `regenerated and committed (${commit.sha.slice(0, 8)})` : "already current" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message.slice(0, 200) };
  }
}
