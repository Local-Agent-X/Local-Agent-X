// Every command position in a shell command line: each top-level segment, and
// every segment inside a body a shell re-parses (`bash -c "…"`, `cmd /c …`,
// `powershell -Command …`), with its real command word resolved past keywords
// and wrappers. The one walk the argv-level shell rules read, so a rule cannot
// forget to look inside a nested shell — the raw-string denylist saw into those
// bodies only by accident, and matched the words of quoted arguments with them.

import { execBasename, isShellReparseFlag, resolveRealArgv0Index, shellSegments, tokenizeCommand } from "./shell-lex.js";

/** One shell redirection of a command: the operator without its fd digits
 *  (`>`, `>>`, `>|`, `>&`, `<`, `<>`, `<<`, `<<<`, `<&`, `&>`, `&>>`) and its
 *  target — a file, an fd for `>&`/`<&`, a delimiter for `<<`, "" when none. */
export interface Redirection {
  op: string;
  target: string;
}

export interface CommandPosition {
  /** The segment's words, quotes removed, redirections taken out (`redirections`). */
  words: string[];
  /** The shell's redirections for this command, in order. */
  redirections: Redirection[];
  /** Index of the real command word in `words` (after keywords/wrappers). */
  at: number;
  /** Basename of the real command word, lowercased (`/usr/bin/Bash.exe` → "bash"). */
  bin: string;
  /** Its stdin is the previous command's output (`a | b`, `a |& b`). */
  piped: boolean;
  /** 0 at top level, +1 per re-parsed shell body. */
  depth: number;
}

export interface CommandWalk {
  positions: CommandPosition[];
  /** A shell body nested past MAX_SHELL_NESTING was found and not walked. */
  tooDeep: boolean;
}

/** Shells within shells past this depth are refused rather than walked. */
export const MAX_SHELL_NESTING = 3;

// A Windows shell takes the REST of its line as the command (`cmd /c type x`,
// `powershell -Command Get-Item x`); a POSIX shell takes the next word.
const REST_OF_LINE_SHELLS = new Set(["cmd", "powershell", "pwsh"]);

export function commandPositions(command: string): CommandWalk {
  const walk: CommandWalk = { positions: [], tooDeep: false };
  visit(command, 0, walk);
  return walk;
}

// A redirection operator word: an optional fd (`2>`) then `>`, `>>`, `>|`,
// `>&`, `<`, `<>`, `<<`, `<<<`, `<&`; or `&>` / `&>>`. Group 2 is the operator,
// group 3 a target attached to it (`2>/dev/null`, `>&2`).
const REDIRECTION = /^(?:(\d*)(>>|>\||>&|>|<<<|<<|<&|<>|<)|()(&>>|&>))(.*)$/;

/**
 * Split a command's words into its arguments and its redirections: `git push
 * origin main 2>&1` pushes `origin main`, and `2>` is not a refspec (a live
 * push on 2026-09-28 was reviewed as UNKNOWN for exactly that). An operator
 * with no attached target takes the next word (`> log`, `2> /dev/null`).
 * Quotes are gone by the time words exist, so a quoted operator (`echo ">"`)
 * is read as one too — an argument fewer for the rules to see, never one more.
 */
function splitRedirections(tokens: string[]): { words: string[]; redirections: Redirection[] } {
  const words: string[] = [];
  const redirections: Redirection[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = REDIRECTION.exec(tokens[i]);
    if (!m) { words.push(tokens[i]); continue; }
    const op = m[2] ?? m[4];
    let target = m[5];
    if (target === "") target = tokens[++i] ?? "";
    redirections.push({ op, target });
  }
  return { words, redirections };
}

function visit(command: string, depth: number, walk: CommandWalk): void {
  for (const seg of shellSegments(command)) {
    const { words, redirections } = splitRedirections(tokenizeCommand(seg.text));
    if (!words.length) continue;
    // Only wrappers and their flags (`sudo -i`, `env`): the first word is what runs.
    const at = resolveRealArgv0Index(words) ?? 0;
    const bin = execBasename(words[at]);
    walk.positions.push({ words, redirections, at, bin, piped: seg.after === "|" || seg.after === "|&", depth });
    for (let i = at + 1; i < words.length - 1; i++) {
      if (!isShellReparseFlag(bin, words[i])) continue;
      if (depth + 1 >= MAX_SHELL_NESTING) {
        walk.tooDeep = true;
        break;
      }
      visit(REST_OF_LINE_SHELLS.has(bin) ? words.slice(i + 1).join(" ") : words[i + 1], depth + 1, walk);
      break; // a shell takes one command body; the words after it are its arguments
    }
  }
}
