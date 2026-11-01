/**
 * What opens a shell command before its first real act: commands that only
 * look (`command -v uv;`, `set -e`, `mkdir -p out`) and one plain `cd <dir>
 * &&`. The shell-write lineage (create-target-path.ts) steps past them to the
 * command's first real act, at the folder it runs in: a file it enrolls as the
 * agent's must hold only this command's bytes, so nothing before the write may
 * act at all. The delete proofs ask a weaker question, whether anything before
 * a delete can move data onto its target, and answer it in delete-prefix.ts.
 *
 * Segments come from the one quote-aware splitter (shell-lex.ts
 * `shellSegments`): a separator inside quotes splits nothing, so `echo 'a; b'`
 * is one inert command, not an opaque one.
 *
 * Fail-closed: anything not provably inert ends the prelude, and a `cd` this
 * cannot place returns null.
 */
import { shellSegments, tokenizeCommand, type ShellSegment } from "../security/layer/shell-lex.js";
import { placeCd } from "../security/layer/shell-delete-targets.js";

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
  const words = tokenizeCommand(segment);
  const head = (words[0] ?? "").toLowerCase();
  if (head === "command") return /^-[vV]$/.test(words[1] ?? "");
  return INERT_HEADS.has(head);
}

/** The segments from `from` on, as one command again: each after the
 *  separator that preceded it. */
function fromSegment(segments: ShellSegment[], from: number): string {
  const glue = (sep: string | null) => (sep === "\n" ? "\n" : sep === ";" ? "; " : ` ${sep} `);
  return segments.slice(from).map((s, i) => (i === 0 ? "" : glue(s.after)) + s.text.trim()).join("");
}

/** Only these carry on to a next command that runs after this one; a pipe
 *  or a single `&` runs both at once. */
const SEQUENTIAL = new Set(["&&", "||", ";", "\n"]);

/** `command` with its leading inert segments removed. A pipe ends the
 *  prelude: its sides run at once. */
export function skipInertPrefix(command: string): string {
  const segments = shellSegments(command);
  let from = 0;
  while (from < segments.length - 1 && inertSegment(segments[from].text) && SEQUENTIAL.has(segments[from + 1].after ?? "")) from++;
  return fromSegment(segments, from);
}

const CD = /^(?:cd|pushd|popd|chdir|set-location|sl)$/i;
const PLACEABLE_CD = /^(?:cd|pushd|set-location|sl)$/i;

/**
 * `cd <dir> && …` opening the command: the rest runs in `dir`, so its targets
 * resolve there (`cd /tmp/alpboot && rm -rf rootfs`, TB2 qemu-startup
 * 2026-10-27, carded a temp folder). Only `&&`, so a cd that fails runs
 * nothing. The folder is placed by the one rule every delete check uses
 * (`placeCd`: no bare name CDPATH could send anywhere, no other drive). The
 * command unchanged when it opens with no cd; null when it opens with one
 * this cannot place. An undefined `cwd` is a folder the caller does not know.
 */
export function enterLeadingCd<C extends string | undefined>(command: string, cwd: C): { command: string; cwd: C | string } | null {
  const segments = shellSegments(command);
  const words = tokenizeCommand(segments[0]?.text ?? "");
  if (!CD.test(words[0] ?? "")) return { command, cwd };
  if (!PLACEABLE_CD.test(words[0]) || words.length !== 2 || segments[1]?.after !== "&&") return null;
  const dir = placeCd(words[1], cwd);
  return dir === null ? null : { command: fromSegment(segments, 1), cwd: dir };
}

/** The command from its first real act, and the folder that act runs in:
 *  inert segments skipped on both sides of one leading `cd`. Null when the
 *  `cd` cannot be placed. */
export function enterPrelude<C extends string | undefined>(command: string, cwd: C): { command: string; cwd: C | string } | null {
  const entered = enterLeadingCd(skipInertPrefix(command), cwd);
  return entered && { command: skipInertPrefix(entered.command), cwd: entered.cwd };
}
