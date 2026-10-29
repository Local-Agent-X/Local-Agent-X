/**
 * Which command, later on the same line, runs a file an earlier command wrote,
 * and as what. `cat > hook.sh <<'EOF' … EOF; bash hook.sh` writes a script and
 * runs it: its text is that shell's commands, and the rules that judge
 * commands must read it. Text written and not run on the line is data: a
 * Makefile, a C file, an init script for later, a Python file a later
 * `python3 x.py` runs as its program, not as shell. The heredoc reader
 * (shell-source-text.ts) and the decode check (shell-detectors.ts) ask this.
 *
 * Fails toward reading: a file is matched by name as well as by path, and a
 * runner the line computes at run time counts as a shell.
 */
import { posix } from "node:path";
import type { CommandPosition } from "./shell-command-positions.js";
import { resolveRealArgv0 } from "./shell-lex.js";

/** Programs that run their input as shell commands. */
export const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish", "source", "."]);
/** Programs that run their input as a program of their own. */
export const INTERPRETERS: ReadonlySet<string> = new Set([
  "python", "perl", "ruby", "node", "php", "deno", "bun", "pwsh", "powershell", "cmd", "xargs",
]);
/** Interpreters whose program text the inline readers can read (shell-inline-destinations.ts). */
export const LANGUAGES: ReadonlySet<string> = new Set(["python", "perl", "ruby", "node", "php", "deno", "bun"]);

export type FileRunner = "shell" | "program" | "interpreter";

/** The program that reads a command's stdin, past an assignment, `(`, `{`, `!`
 *  and wrappers; null when the program is computed at run time, which fails
 *  closed as a shell. */
export function readerBin(words: string[]): string | null {
  const bin = resolveRealArgv0(words.map((w) => w.replace(/^(?:[A-Za-z_]\w*=(?=\$\())?(?:\$\(|[<>]\(|[({!`])+/, "")).filter(Boolean));
  return bin === null || /[$`]/.test(bin) ? null : bin;
}

/** The files a command writes its output to: `> f`, `>> f`, `>| f`, `&> f`, and tee's operands. */
export function outputFiles(p: CommandPosition): string[] {
  const out = p.redirections.filter((r) => /^&?>>?$|^>\|$/.test(r.op) && !/^&?\d*$/.test(r.target)).map((r) => r.target);
  if (p.bin === "tee") out.push(...p.words.slice(p.at + 1).filter((w) => !w.startsWith("-")));
  return out.filter(Boolean);
}

const names = (word: string, file: string) => word === file || posix.basename(word) === posix.basename(file);
const MAKEFILES = new Set(["Makefile", "makefile", "GNUmakefile"]);
// Git runs a repository's hooks itself, on the commands that reach them.
const GIT_HOOK_RUNNERS = new Set(["push", "commit", "merge", "am", "rebase", "checkout", "switch", "pull", "receive-pack"]);

/** What a file whose first line is `firstLine` runs as when executed directly. */
function byShebang(firstLine: string): FileRunner {
  const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(firstLine);
  if (!m) return "shell";
  const bin = posix.basename(m[1]) === "env" ? (m[2] ?? "") : posix.basename(m[1]);
  const base = bin.replace(/\d+(?:\.\d+)*$/, "");
  if (SHELLS.has(base)) return "shell";
  return LANGUAGES.has(base) ? "program" : "interpreter";
}

/** How `p` runs `file`, if it does. */
function runOf(p: CommandPosition, file: string, firstLine: string): FileRunner | null {
  const args = p.words.slice(p.at + 1);
  const command = p.words[p.at] ?? "";
  if (command.includes("/") && names(command, file)) return byShebang(firstLine);
  const bin = readerBin(p.words);
  if (bin === null) return args.some((a) => names(a, file)) ? "shell" : null;
  // A Makefile is make's input, not a shell script: make expands its own
  // `$(CC)` and runs only the recipes. Read as shell, `$(CC)` was a command
  // substitution (TB2 make-doom-for-mips, 2026-10-28). Its text stays on the
  // line, where the floor still reads a recipe's `rm -rf`.
  if (bin === "make") {
    const f = args.findIndex((a) => a === "-f" || a === "--file" || a === "--makefile");
    return (f >= 0 && names(args[f + 1] ?? "", file)) || (f < 0 && MAKEFILES.has(posix.basename(file))) ? "interpreter" : null;
  }
  if (bin === "git" && /\/hooks\/[^/]+$/.test(file) && args.some((a) => GIT_HOOK_RUNNERS.has(a))) return "shell";
  if (bin === "service" && file.startsWith("/etc/init.d/") && args[0] === posix.basename(file)) return "shell";
  if (!args.some((a) => names(a, file))) return null;
  if (SHELLS.has(bin)) return "shell";
  if (INTERPRETERS.has(bin)) return LANGUAGES.has(bin) ? "program" : "interpreter";
  return null;
}

/**
 * How the first command after `from` in `positions` that runs `file` runs it:
 * as shell commands, as a language's program, or as another interpreter's
 * input; null when none does. `firstLine` is the file's first line, for a file
 * run directly (`./x`, `/etc/init.d/x start`), whose shebang decides; none is
 * a shell.
 */
export function laterRunOf(positions: readonly CommandPosition[], from: number, file: string, firstLine = ""): FileRunner | null {
  for (const p of positions.slice(from + 1)) {
    const run = runOf(p, file, firstLine);
    if (run) return run;
  }
  return null;
}
