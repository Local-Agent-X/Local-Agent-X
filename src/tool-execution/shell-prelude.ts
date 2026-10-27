/**
 * What opens a shell command before its first real act: commands that only
 * look (`command -v uv;`, `set -e`, `mkdir -p out`) and one plain `cd <dir>
 * &&`. The approval checks that read the disk before a command runs
 * (disposable-tree-delete.ts) and the shell-write lineage
 * (create-target-path.ts) step past them to the command's first real act, at
 * the folder it runs in.
 *
 * Fail-closed: anything not provably inert ends the prelude, and a `cd` this
 * cannot place returns null.
 */
import { isAbsolute, resolve } from "node:path";
import { shellWords } from "./shell-delete-targets.js";

const EXPANDS = /[$`*?~%]/;

/** Commands that read or print, or make an empty folder: none can move,
 *  rename or write anyone's bytes. `export` and assignments are not here: a
 *  changed PATH changes what `rm` runs. */
const INERT_HEADS: ReadonlySet<string> = new Set([
  "which", "type", "echo", "printf", "true", ":", "pwd", "ls", "set", "test", "[", "mkdir",
  "nproc", "uname", "whoami", "id", "date",
]);

/** One segment that only looks: an inert head, no redirection, nothing nested. */
function inertSegment(segment: string): boolean {
  if (/[<>`]|\$\(/.test(segment)) return false;
  const words = shellWords(segment);
  const head = (words[0] ?? "").toLowerCase();
  if (head === "command") return /^-[vV]$/.test(words[1] ?? "");
  return INERT_HEADS.has(head);
}

// One segment with no separator and no quote in it but the empty `""` the
// floor blanks a lookup's operand to (approval-decision.ts), then its separator.
const LEADING_SEGMENT = /^\s*((?:[^;&|\n'"]|"")*?)\s*(?:&&|\|\||;|\n)/;

/** `command` with its leading inert segments removed. A pipe ends the
 *  prelude: its sides run at once. */
export function skipInertPrefix(command: string): string {
  let rest = command;
  for (let m = LEADING_SEGMENT.exec(rest); m && m[1] && inertSegment(m[1]); m = LEADING_SEGMENT.exec(rest)) {
    rest = rest.slice(m[0].length);
  }
  return rest.trimStart();
}

const CD = /^(?:cd|pushd|popd|chdir|set-location|sl)\b/i;
const LEADING_CD = /^\s*(?:cd|pushd|set-location|sl)\s+("[^"]*"|'[^']*'|[^\s"';&|]+)\s*&&/i;

/**
 * `cd <dir> && …` opening the command: the rest runs in `dir`, so its targets
 * resolve there (`cd /tmp/alpboot && rm -rf rootfs`, TB2 qemu-startup
 * 2026-10-27, carded a temp folder). Only `&&`, so a cd that fails runs
 * nothing; only an absolute or `./` / `../` dir, since CDPATH can send a bare
 * name anywhere; never across drives, where cmd's `cd` keeps the old drive.
 * The command unchanged when it opens with no cd; null when it opens with one
 * this cannot place. An undefined `cwd` is a folder the caller does not know:
 * only a cd to an absolute folder on no other drive can be placed from it.
 */
export function enterLeadingCd<C extends string | undefined>(command: string, cwd: C): { command: string; cwd: C | string } | null {
  if (!CD.test(command.trimStart())) return { command, cwd };
  const m = LEADING_CD.exec(command);
  if (!m) return null;
  const [dir] = shellWords(m[1]);
  if (!dir || EXPANDS.test(dir) || dir.startsWith("-")) return null;
  if (!isAbsolute(dir) && (cwd === undefined || !/^\.\.?(?:[\\/]|$)/.test(dir))) return null;
  if (/^[a-z]:/i.test(dir) && (cwd === undefined || dir[0].toLowerCase() !== resolve(cwd)[0].toLowerCase())) return null;
  if (process.platform === "win32" && /^[\\/]/.test(dir)) return null;   // Git Bash's `/c/…` is not C:\c\…
  return { command: command.slice(m[0].length).trimStart(), cwd: resolve(cwd ?? "", dir) };
}

/** The command from its first real act, and the folder that act runs in:
 *  inert segments skipped on both sides of one leading `cd`. Null when the
 *  `cd` cannot be placed. */
export function enterPrelude<C extends string | undefined>(command: string, cwd: C): { command: string; cwd: C | string } | null {
  const entered = enterLeadingCd(skipInertPrefix(command), cwd);
  return entered && { command: skipInertPrefix(entered.command), cwd: entered.cwd };
}
