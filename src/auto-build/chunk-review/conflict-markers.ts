/**
 * Files a chunk left with git's conflict markers in them.
 *
 * A chunk whose work conflicts with what landed before it is handed to a
 * worker with the conflict in its tree (loop/carry-over.ts). The engine then
 * commits whatever is there, and `git add -A` takes a file with markers as
 * resolved: this is the check that a worker really did combine the two sides.
 * Measured on the files, not on what the worker says.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GateFinding } from "./gates.js";

const OPEN = /^<{7} /m;
const CLOSE = /^>{7} /m;
/** Nothing a person merges by hand is this large; a bundle or a data file is skipped. */
const MAX_BYTES = 2 * 1024 * 1024;

export function filesWithConflictMarkers(tree: string, files: readonly string[]): string[] {
  return files.filter((file) => {
    const path = join(tree, file);
    try {
      if (!existsSync(path) || statSync(path).size > MAX_BYTES) return false;
      const text = readFileSync(path, "utf8");
      return OPEN.test(text) && CLOSE.test(text);
    } catch {
      return false; // unreadable (a directory, a locked file): not evidence of a marker
    }
  });
}

/** The finding that sends the chunk back, or null when no changed file holds a marker. */
export function gateConflictMarkers(tree: string, changed: readonly string[]): GateFinding | null {
  const left = filesWithConflictMarkers(tree, changed);
  if (left.length === 0) return null;
  return {
    gate: "worktree-merge", action: "push_back",
    reasoning: `These files still hold merge conflict markers (<<<<<<< / >>>>>>>): ${left.join(", ")}. ` +
      "In each, keep what both sides were for (what landed before this chunk and this chunk's own change), delete every marker line, and run the checks again.",
  };
}
