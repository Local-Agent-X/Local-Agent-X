/**
 * The project's local files a chunk's worktree does not get from git.
 *
 * A worktree holds what git tracks. A project also keeps files git ignores on
 * purpose and its build still needs: a Firebase config, an env file, a
 * stand-in google-services.json. A chunk built in the project itself found
 * them; the same chunk in a worktree did not, and failed its build for a
 * reason that had nothing to do with its code (label-check, 2026-11-22, the
 * Android chunk and the web config).
 *
 * So each ignored FILE is copied into the worktree where the project has it.
 * Ignored FOLDERS are not: those are what a build produces or installs
 * (node_modules, dist, a cache), and the worktree gets or makes its own. The
 * copies are ignored in the worktree too, so no merge ever carries one back.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "../../agency/worktree-core.js";
import { isEngineStateEntry } from "../engine-state-files.js";

/** Larger than any config: a file past this is build output or data. */
const MAX_LOCAL_FILE_BYTES = 1024 * 1024;
const MAX_LOCAL_FILES = 200;

/** The files `projectDir` ignores, by repo-relative path. A folder ignored
 *  whole is one entry ending in "/" and is left out, and so is the build
 *  engine's own state beside the project: the base's, never a worktree's. */
function ignoredFiles(projectDir: string): string[] {
  return git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], projectDir)
    .split("\n").map((line) => line.trim()).filter((file) => file && !file.endsWith("/") && !isEngineStateEntry(file.split("/").pop()!, false));
}

/**
 * Copy the project's ignored files into a fresh worktree of it. Returns the
 * paths copied; a file the worktree already has, or one too large to be
 * config, is left alone. Never throws: a worktree without them is what every
 * chunk had before, and the chunk's own build says what it could not find.
 */
export function copyLocalFiles(projectDir: string, worktreePath: string): string[] {
  const copied: string[] = [];
  try {
    for (const file of ignoredFiles(projectDir).slice(0, MAX_LOCAL_FILES)) {
      const from = join(projectDir, file);
      const to = join(worktreePath, file);
      if (existsSync(to) || statSync(from).size > MAX_LOCAL_FILE_BYTES) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(file);
    }
  } catch {
    // What was copied so far stands; the rest is missing, as it was before this existed.
  }
  return copied;
}
