// Every command position in a shell command line: each top-level segment, and
// every segment inside a body a shell re-parses (`bash -c "…"`, `cmd /c …`,
// `powershell -Command …`), with its real command word resolved past keywords
// and wrappers. The one walk the argv-level shell rules read, so a rule cannot
// forget to look inside a nested shell — the raw-string denylist saw into those
// bodies only by accident, and matched the words of quoted arguments with them.

import { execBasename, isShellReparseFlag, resolveRealArgv0Index, shellSegments, tokenizeCommand } from "./shell-lex.js";

export interface CommandPosition {
  /** The segment's words, quotes removed. */
  words: string[];
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

function visit(command: string, depth: number, walk: CommandWalk): void {
  for (const seg of shellSegments(command)) {
    const words = tokenizeCommand(seg.text);
    const at = resolveRealArgv0Index(words);
    if (at === null) continue;
    const bin = execBasename(words[at]);
    walk.positions.push({ words, at, bin, piped: seg.after === "|" || seg.after === "|&", depth });
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
