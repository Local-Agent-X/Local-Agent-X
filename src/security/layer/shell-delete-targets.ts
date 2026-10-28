/**
 * Every delete a shell command makes: its form, whether it is recursive, its
 * targets as written, and the folder it runs in. The one delete extractor
 * every delete rule reads — the un-named-delete gate, the disposable-delete
 * proof, the post-run delete check, the task-artifact guard, the mutation
 * locks, the catastrophic floor and the confined-mode rm rule. Seven private
 * parsers disagreed on real commands (audit 2026-10-27): one saw no delete in
 * `timeout 5 rm users.csv`, one cut `git commit -m "fix; rm -f x"` inside its
 * quotes, one read `C:\Temp\x.tmp` as `C:Tempx.tmp`, one knew only rm.
 *
 * It reads the walk the argv-level shell rules read (shell-command-positions.ts
 * `commandPositions`): quote-aware segments, wrappers looked through (sudo,
 * env, timeout, nohup, nice, xargs, …), `bash -c` / `cmd /c` / `powershell
 * -Command` bodies re-read, redirections taken out. It reads argv-shaped text;
 * it expands nothing, so a glob or `$VAR` target comes back as written.
 *
 * EXP-18 (2026-09-24) is why single-file deletes are listed at all: with
 * `delete_file` out of the schema the model fell from `rm -rf` (carded by the
 * irreversible floor) to five single-file `rm` commands no gate covered.
 */
import { isAbsolute, resolve } from "node:path";
import { commandPositions, type CommandPosition } from "./shell-command-positions.js";
import { shellSegments } from "./shell-lex.js";

/** The form of a delete, which fixes how its words read: POSIX `rm`,
 *  `unlink`, `shred` and `rmdir`; cmd.exe `rd` and `del`; PowerShell
 *  `Remove-Item`, whose aliases (`ri`, and `rm`, `del`, `rd` written with its
 *  parameters) read the same. */
export type DeleteVerb = "rm" | "unlink" | "shred" | "rmdir" | "rd" | "del" | "remove-item";

export interface DeleteCall {
  verb: DeleteVerb;
  /** The delete's own command word, lowercased (`rm`, `ri`, `erase`). */
  bin: string;
  /** Removes a whole tree (`rm -r`, `-Recurse`, `rd /s`, `del /s`). */
  recursive: boolean;
  /** Overrides a prompt or a read-only bit (`-f`, `-Force`, `del /f`). */
  forced: boolean;
  /** Operands as written, quotes removed; a PowerShell comma list split. */
  targets: string[];
  /** The delete's flags as written, in order. */
  flags: string[];
  /** A parameter this does not read was given (`-Filter`, `-Include`): what
   *  is deleted is not exactly `targets`. */
  opaque: boolean;
  /** Run by a wrapper (sudo, timeout, xargs, …), inside a shell's body, or
   *  after an assignment (`PATH=… rm` changes which rm runs). */
  wrapped: boolean;
}

export interface ShellDelete extends DeleteCall {
  /** The folder relative targets resolve at: the caller's `base` when nothing
   *  moved it, the folder a placeable `cd` entered, or null after a `cd` this
   *  cannot place (shell-prelude.ts has the rules, `placeCd`). */
  cwd: string | null | undefined;
  /** The top-level segment the delete is, or sits in the body of. */
  segment: number;
}

// A word that only PowerShell spells: `rm -Recurse x` is Remove-Item's alias.
const PS_PARAM = /^-(?:recurse|rec\w+|force|path|literalpath|lp|erroraction|ea|include|exclude|filter|confirm(?::\S*)?|whatif|stream|credential)$/i;
const DOS_SWITCH = /^\/[a-z?]{1,2}(?::\S*)?$/i;

/** The delete one command position makes, or null when it makes none. */
export function deleteOf(p: CommandPosition): DeleteCall | null {
  const args = p.words.slice(p.at + 1);
  const wrapped = p.depth > 0 || p.at > 0;
  const call = (verb: DeleteVerb, parsed: Parsed): DeleteCall => ({ verb, bin: p.bin, wrapped, ...parsed });
  const ps = args.some((w) => PS_PARAM.test(w));
  switch (p.bin) {
    case "rm": return ps ? call("remove-item", powershell(args)) : call("rm", posix(args, "rRf"));
    case "unlink": return call("unlink", posix(args, ""));
    case "shred": return call("shred", posix(args, "f", /^-[ns]$/));
    case "rmdir": case "rd":
      if (args.some((w) => DOS_SWITCH.test(w))) return call("rd", dos(args));
      return ps ? call("remove-item", powershell(args)) : call("rmdir", posix(args, ""));
    case "del": case "erase": return ps ? call("remove-item", powershell(args)) : call("del", dos(args));
    case "remove-item": case "ri": return call("remove-item", powershell(args));
    default: return null;
  }
}

type Parsed = Pick<DeleteCall, "recursive" | "forced" | "targets" | "flags" | "opaque">;

/** POSIX words: flags until `--`, then operands. `letters` are the cluster
 *  letters that mean recursive (r, R) and forced (f); `valued` flags take the
 *  next word (`shred -n 3`). */
function posix(args: string[], letters: string, valued?: RegExp): Parsed {
  const out: Parsed = { recursive: false, forced: false, targets: [], flags: [], opaque: false };
  let operands = false;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (operands || !w.startsWith("-") || w === "-") { out.targets.push(w); continue; }
    if (w === "--") { operands = true; continue; }
    out.flags.push(w);
    if (valued?.test(w)) { i++; continue; }
    const cluster = /^-[^-]/.test(w) ? w.slice(1) : "";
    if (/[rR]/.test(letters) && (/[rR]/.test(cluster) || w === "--recursive")) out.recursive = true;
    if (letters.includes("f") && (cluster.includes("f") || w === "--force")) out.forced = true;
  }
  return out;
}

/** cmd.exe words: `/x` switches anywhere, every other word a target. */
function dos(args: string[]): Parsed {
  const flags = args.filter((w) => DOS_SWITCH.test(w));
  const has = (s: string) => flags.some((f) => f.toLowerCase() === s);
  return { recursive: has("/s"), forced: has("/f"), targets: args.filter((w) => !DOS_SWITCH.test(w)), flags, opaque: false };
}

const PS_SWITCHES = /^-(?:force|f|recurse|rec\w*|r|whatif|confirm|verbose|debug|passthru)(?::\S*)?$/i;

/** PowerShell words. Switches stand alone (`-Confirm:$false` is one word);
 *  every other parameter takes the next word as its value, which is not a
 *  path the user must have named — found live: `-ErrorAction Stop` read as a
 *  file called "Stop" (2026-09-24). */
function powershell(args: string[]): Parsed {
  const out: Parsed = { recursive: false, forced: false, targets: [], flags: [], opaque: false };
  const add = (w: string) => out.targets.push(...w.split(",").map((t) => t.trim()).filter(Boolean));
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (!w.startsWith("-") || w.length === 1) { add(w); continue; }
    out.flags.push(w);
    if (/^-(?:path|literalpath|lp)$/i.test(w)) { if (args[i + 1] === undefined) out.opaque = true; else add(args[++i]); continue; }
    if (PS_SWITCHES.test(w)) {
      if (/^-r(?:ec\w*)?(?::\$true)?$/i.test(w)) out.recursive = true;
      if (/^-f(?:orce)?(?::\$true)?$/i.test(w)) out.forced = true;
      continue;
    }
    if (!/^-(?:erroraction|ea)$/i.test(w)) out.opaque = true;
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i++;
  }
  return out;
}

const CD_BINS = new Set(["cd", "pushd", "chdir", "set-location", "sl", "push-location"]);
const CD_UNPLACEABLE = new Set(["popd", "pop-location"]);
const EXPANDS = /[$`*?~%]/;

/**
 * The folder `cd <dir>` enters from `cwd`, or null when it cannot be placed:
 * an expansion; a bare name, which CDPATH can send anywhere (only absolute,
 * `./` and `../` dirs); a `-` option; another drive, where cmd's `cd` keeps
 * the old one; and on Windows a `/x/…` path, Git Bash's mount, not C:\x. An
 * undefined `cwd` is a folder the caller does not know: only an absolute dir
 * on no other drive can be placed from it.
 */
export function placeCd(dir: string | undefined, cwd: string | undefined): string | null {
  if (!dir || EXPANDS.test(dir) || dir.startsWith("-")) return null;
  if (!isAbsolute(dir) && (cwd === undefined || !/^\.\.?(?:[\\/]|$)/.test(dir))) return null;
  if (/^[a-z]:/i.test(dir) && (cwd === undefined || dir[0].toLowerCase() !== resolve(cwd)[0].toLowerCase())) return null;
  if (process.platform === "win32" && /^[\\/]/.test(dir)) return null;
  return resolve(cwd ?? "", dir);
}

/** The folder a cd position leaves the next command in. Only `&&` carries it:
 *  after `;`, `||` or a newline the next command runs where a failed cd left
 *  it, and a piped or backgrounded cd runs in a subshell. */
function afterCd(p: CommandPosition, next: CommandPosition | undefined, cwd: string | null | undefined): string | null | undefined {
  if (!next || next.depth < p.depth) return cwd;
  if (CD_UNPLACEABLE.has(p.bin) || cwd === null || next.join !== "&&") return null;
  // bash's -P/-L/-e and PowerShell's -Path name no folder; `cd -` does, one placeCd refuses.
  return placeCd(p.words.slice(p.at + 1).find((w) => !/^-(?:[PLe]|path|literalpath)$/i.test(w)), cwd);
}

/** Every delete in `command`, in order, with the folder each runs in from
 *  `base` (the shell's folder; undefined when the caller does not know it).
 *  A `cd` inside a shell's body moves only the rest of that body. */
export function shellDeletes(command: string, base?: string): ShellDelete[] {
  const positions = commandPositions(command).positions;
  const cwds: Array<string | null | undefined> = [base];
  const out: ShellDelete[] = [];
  positions.forEach((p, i) => {
    // A body is walked right after the shell that runs it, one level deeper,
    // and starts where that shell is; leaving it drops what it moved.
    if (p.depth >= cwds.length) cwds.push(cwds[cwds.length - 1]);
    else cwds.length = p.depth + 1;
    const cwd = cwds[p.depth];
    if (CD_BINS.has(p.bin) || CD_UNPLACEABLE.has(p.bin)) {
      const next = positions.slice(i + 1).find((q) => q.depth <= p.depth);
      cwds[p.depth] = afterCd(p, next, cwd);
      return;
    }
    const del = deleteOf(p);
    if (del) out.push({ ...del, cwd, segment: p.segment });
  });
  return out;
}

/** The deletes `command` makes when every command in it is a delete, a shell
 *  that only carries a body, or a command named in `alsoAllowed`; else null.
 *  A body nested too deep to walk is null. */
export function deletesOnly(command: string, alsoAllowed: ReadonlySet<string> = new Set()): DeleteCall[] | null {
  const walk = commandPositions(command);
  if (walk.tooDeep) return null;
  const out: DeleteCall[] = [];
  for (const p of walk.positions) {
    const del = deleteOf(p);
    if (del) out.push(del);
    else if (!p.reparses && !alsoAllowed.has(p.bin)) return null;
  }
  return out;
}

/** A segment that is exactly one delete, run by no wrapper and in no body. */
export function plainDelete(segment: string): DeleteCall | null {
  const dels = deletesOnly(segment);
  return dels?.length === 1 && !dels[0].wrapped ? dels[0] : null;
}

/**
 * The top-level segments opening `command` that `leads` accepts, in order:
 * the run that starts before anything else in the command. Null when a pipe
 * or a single `&` joins one of them to a neighbour, since those run at once
 * and the neighbour could act while the run does (`rm -rf x & mv client-data
 * x`). What follows the run starts after it, piped or not: `rm -rf dist &&
 * npm run build 2>&1 | tail` (TB2 rstan-to-pystan, 2026-10-24).
 */
export function leadingRun(command: string, leads: (segment: string) => boolean): string[] | null {
  const run: string[] = [];
  for (const seg of shellSegments(command)) {
    const segment = seg.text.trim();
    if (!segment) continue;
    const joined = seg.after === "|" || seg.after === "|&" || seg.after === "&";
    if (!leads(segment)) return joined && run.length > 0 ? null : run;
    if (joined) return null;
    run.push(segment);
  }
  return run;
}

/** The targets of the plain single-file deletes that open the command, before
 *  anything else in it runs (`leadingRun`), or [] when something could run
 *  first or alongside. What the disk shows before the call is what those
 *  deletes meet, so `mv users.csv a && rm -f a` never qualifies. */
export function leadingShellDeleteTargets(command: string): string[] {
  const single = (seg: string) => {
    const del = plainDelete(seg);
    return del !== null && !del.recursive && del.targets.length > 0;
  };
  const out: string[] = [];
  for (const seg of leadingRun(command, single) ?? []) {
    for (const p of plainDelete(seg)!.targets) if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Every file a command deletes one at a time, in order, deduplicated: the
 *  un-named-delete gate's list. The recursive forms are the irreversible
 *  floor's (approval-decision.ts), which cards them, so they are not listed
 *  for a second card; nor is a plain `rmdir`, which removes only an empty
 *  folder. Globs are kept as written: a pattern names no file. */
export function shellDeleteTargets(command: string): string[] {
  const out: string[] = [];
  for (const del of shellDeletes(command)) {
    if (del.recursive || del.verb === "rmdir" || del.verb === "rd") continue;
    for (const p of del.targets) if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
