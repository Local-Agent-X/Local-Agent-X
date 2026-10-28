/**
 * What a command runs before one of its deletes, read for the two ways it
 * could turn a delete of nobody's data into a delete of someone's: putting
 * existing data at the delete's target first, or changing which program the
 * delete runs. The disposable-delete proofs (disposable-tree-delete.ts) read
 * the disk before the command runs, so until 2026-10-28 they proved only a
 * delete that opened the command. TB2 that day carded `set -e; export
 * SSHPASS=…; rm -rf /tmp/clonetest`, `cd /tmp && tar xzf cc.tgz && rm -rf
 * CompCert`, `kill $(cat qemu.pid); sleep 2; rm -f qmp.sock qemu.pid` and
 * `ln -sf …/win311 && rm -f …/sites-enabled/default`.
 *
 * Copying, extracting, building and running a program leave every original
 * where it was: what they put at a target is their own output. Data is
 * relocated by a move or a link (mv, ln, rsync, mount --bind, …), and only to
 * the paths its operands spell: an operand, or an operand with another's name
 * under it. Such a command is harmless when every operand is a literal
 * absolute path and none of those paths is the target, a folder holding it,
 * or a path inside it. A compressor that replaces its input (`gzip a` leaves
 * only `a.gz`) renames it the same way, and an archiver told to remove what it
 * packs (`tar --remove-files`, `zip -m`) is never proven. An interpreter whose program text names the target's
 * folders or name may do the same and is not proven. The program a delete
 * runs changes with PATH and the shell's other lookup variables, an alias, a
 * function, `source`, `hash` or `enable`.
 *
 * Left out by design: a program that computes the path it moves data to, so
 * no command text shows it. That program could as well delete the data
 * itself, which no delete check sees either.
 */
import { accessSync, constants, statSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { commandPositions, type CommandPosition } from "../security/layer/shell-command-positions.js";
import { shellDeletes, type CdSucceeds } from "../security/layer/shell-delete-targets.js";
import { shellSegments } from "../security/layer/shell-lex.js";
import { expansionsIn } from "../security/layer/shell-nested-commands.js";
import { readSourceText } from "../security/layer/shell-source-text.js";

const RELOCATORS: ReadonlySet<string> = new Set([
  "mv", "rename", "ln", "link", "rsync", "mount", "mklink",
  "move", "move-item", "mi", "ren", "rename-item", "rni", "new-item", "ni",
]);
const LOOKUP_CHANGERS: ReadonlySet<string> = new Set([
  "alias", "hash", "enable", "source", ".", "function", "set-alias", "new-alias", "sal", "nal",
]);
const LOOKUP_VARIABLE = /^(?:PATH|BASH_ENV|ENV|IFS|CDPATH|SHELLOPTS|BASHOPTS|GLOBIGNORE|LD_\w+|DYLD_\w+)=/;
const IN_PLACE_COMPRESSORS: ReadonlySet<string> = new Set([
  "gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "lzma", "unlzma", "lzip", "compress", "uncompress", "pigz", "pbzip2", "zstd", "unzstd",
]);
const INTERPRETERS: ReadonlySet<string> = new Set(["python", "perl", "ruby", "node", "php", "deno", "bun"]);
const UNPLACEABLE = /[$`*?~{}[\]%]/;
const CONCURRENT = new Set(["|", "|&", "&"]);

/** `command` as bash parses it, each heredoc body a word of the program that
 *  reads it (shell-source-text.ts). Null when a heredoc hands a shell a
 *  script, whose deletes and moves this does not read. On Windows, where
 *  heredocs are not shell syntax, the command unchanged. */
export function deleteLine(command: string): string | null {
  if (process.platform === "win32") return command;
  const source = readSourceText(command);
  return source.scripts.length > 0 ? null : source.command;
}

/** Top-level segment `at` runs alone: no pipe or `&` joins it to a neighbour,
 *  which would run at the same time. */
export function runsAlone(line: string, at: number): boolean {
  const segments = shellSegments(line);
  return !CONCURRENT.has(segments[at]?.after ?? "") && !CONCURRENT.has(segments[at + 1]?.after ?? "");
}

const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));

function related(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep);
}

/** A move or link whose every landing place is a literal path away from `target`. */
function relocationMissing(p: CommandPosition, target: string): boolean {
  const before = p.words.slice(0, p.at);
  if (before.some((w) => /^(?:xargs|parallel)$/.test(w))) return false;
  const operands: string[] = [];
  const args = p.words.slice(p.at + 1);
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "-t" || w === "--target-directory") { operands.push(args[++i] ?? ""); continue; }
    if (w.startsWith("--target-directory=")) { operands.push(w.slice("--target-directory=".length)); continue; }
    if (w.startsWith("-")) continue;
    operands.push(w);
  }
  if (operands.length < 2 || operands.some((o) => !o || UNPLACEABLE.test(o) || !isAbsolute(o))) return false;
  const t = norm(target);
  const landings = operands.flatMap((o) => [o, ...operands.filter((q) => q !== o).map((q) => resolve(o, basename(q)))]);
  return !landings.some((l) => related(norm(l), t));
}

/** A compressor that replaces its input with its output (`gzip a` leaves
 *  `a.gz` and no `a`, `gunzip a.gz` the reverse) keeps the data under a new
 *  name: harmless only when no literal absolute operand is the target's name
 *  with a suffix added or taken off. */
function inPlaceRenameMissing(p: CommandPosition, target: string): boolean {
  const args = p.words.slice(p.at + 1);
  if (args.some((w) => /^-[a-z]*[kc]|^--(?:keep|stdout|to-stdout)$/i.test(w))) return true;
  const operands = args.filter((w) => !w.startsWith("-"));
  if (operands.some((o) => UNPLACEABLE.test(o) || !isAbsolute(o))) return false;
  const t = norm(target);
  return !operands.some((o) => t.startsWith(norm(o)) || norm(o).startsWith(t));
}

// Moves its sources into an archive it writes (tar --remove-files, zip -m, 7z -sdel).
const ARCHIVE_MOVE = /^--remove-files$|^-sdel$|^--move$/;

function changesLookup(p: CommandPosition): boolean {
  if (p.words.some((w) => LOOKUP_VARIABLE.test(w))) return true;
  if (LOOKUP_CHANGERS.has(p.bin) || /^[\w.:-]+\(\)$/.test(p.words[0] ?? "") || p.words[1] === "()") return true;
  return false;
}

/** The names an interpreter's program would spell to move data onto `target`:
 *  its own name and its folders' below the top level. */
function targetNames(target: string): RegExp[] {
  const parts = target.split(/[\\/]+/).filter((s) => s && !/^[a-z]:$/i.test(s));
  return (parts.length > 1 ? parts.slice(1) : parts).map((name) =>
    new RegExp(`(?<![\\w.-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`));
}

function harmless(p: CommandPosition, target: string): boolean {
  if (changesLookup(p)) return false;
  if (p.bin === "git" && p.words.slice(p.at + 1).includes("mv")) return false;
  if (p.bin === "find" && p.words.some((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w))) return false;
  if (p.words.some((w) => ARCHIVE_MOVE.test(w)) || (p.bin === "zip" && p.words.some((w) => /^-[a-z]*m/.test(w)))) return false;
  if (RELOCATORS.has(p.bin)) return relocationMissing(p, target);
  if (IN_PLACE_COMPRESSORS.has(p.bin)) return inPlaceRenameMissing(p, target);
  if (INTERPRETERS.has(p.bin)) {
    const names = targetNames(target);
    return !p.words.slice(p.at + 1).some((w) => names.some((n) => n.test(w)));
  }
  return true;
}

/** Every command `text` runs, nested `$(…)` and backticks included, is harmless. */
function allHarmless(text: string, target: string, depth = 0): boolean {
  const walk = commandPositions(text);
  if (walk.tooDeep || depth > 3) return false;
  if (!walk.positions.every((p) => harmless(p, target))) return false;
  return expansionsIn(text).every((e) => allHarmless(e.replace(/^(?:\$[({]|`)|[)}`]$/g, ""), target, depth + 1));
}

/** Does path `a` overlap `b`: the same path, or one inside the other? */
export function pathsOverlap(a: string, b: string): boolean {
  return related(norm(a), norm(b));
}

/**
 * The top-level `cd`s in `line` that cannot fail, for shellDeletes: the folder
 * exists, may be entered, and nothing before the cd moves it away (the rule
 * above) or deletes it. A failed cd leaves the commands after a `;` or a
 * newline running in the old folder, so only a proven one carries there.
 */
export function cdCannotFail(line: string): CdSucceeds {
  return (dir, segment) => {
    try {
      if (!statSync(dir).isDirectory()) return false;
      accessSync(dir, constants.X_OK);
    } catch {
      return false; /* missing or not enterable: the cd may fail */
    }
    if (!priorRunsLeave(line, segment, dir)) return false;
    return shellDeletes(line).filter((d) => d.segment < segment).every((d) =>
      d.targets.every((t) => !UNPLACEABLE.test(t) && (isAbsolute(t) || typeof d.cwd === "string") && !pathsOverlap(resolve(d.cwd ?? "", t), dir)));
  };
}

/**
 * True when nothing `line` runs before its top-level segment `at` can put
 * existing data at `target` (absolute) or change which program that segment
 * runs (see the header). `line` is read as deleteLine returns it.
 */
export function priorRunsLeave(line: string, at: number, target: string): boolean {
  const before = shellSegments(line).slice(0, at).map((s) => s.text).filter((s) => s.trim());
  return before.every((segment) => allHarmless(segment, target));
}
