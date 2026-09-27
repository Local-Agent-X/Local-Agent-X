// Shell rules that judge the COMMAND BEING RUN — its real command word, its
// own arguments, what feeds its stdin — read from commandPositions, which also
// walks the bodies nested shells re-parse. A word inside a quoted argument
// (`git commit -m "fix eval"`) or a later, unrelated command (`a | head;
// powershell -File x.ps1`) is never mistaken for the command.

import { commandPositions, MAX_SHELL_NESTING, type CommandPosition } from "./shell-command-positions.js";
import { isShellReparseFlag } from "./shell-lex.js";

export type CommandRuleCategory = "shell-escape";

export interface CommandRule {
  id: string;
  category: CommandRuleCategory;
  /** Finishes "Blocked: `<bin>` …" — what the command does that is refused. */
  why: string;
  matches(p: CommandPosition): boolean;
}

// `eval` and PowerShell's equivalents run a STRING as a command: whatever it
// builds is invisible to every rule that reads the command line.
const EVAL_BINS = new Set(["eval", "iex", "invoke-expression"]);

const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
const AWK_BINS = new Set(["awk", "gawk", "mawk", "nawk"]);

// Does this shell take its SCRIPT from stdin? Only then is a pipe into it
// "run whatever the previous command printed". `find . | xargs bash -c '…'`
// runs a visible, walked body; `curl … | sh` runs the download.
function readsScriptFromStdin(p: CommandPosition): boolean {
  const args = p.words.slice(p.at + 1);
  if (POSIX_SHELLS.has(p.bin)) {
    if (args.some((a) => isShellReparseFlag(p.bin, a))) return false;
    if (args.some((a) => /^-[a-zA-Z]*s[a-zA-Z]*$/.test(a))) return true; // `sh -s`: script from stdin, args after
    return !args.some((a) => a !== "-" && !/^[-+]/.test(a)); // no script file operand
  }
  if (p.bin === "cmd") return !args.some((a) => /^\/[ck]$/i.test(a));
  if (p.bin === "powershell" || p.bin === "pwsh") {
    const lower = args.map((a) => a.toLowerCase());
    if (lower.includes("-file") || lower.includes("-f")) return false;
    const c = lower.findIndex((a) => a === "-command" || a === "-c");
    if (c >= 0) return c + 1 >= lower.length || lower[c + 1] === "-";
    return !lower.some((a) => !a.startsWith("-"));
  }
  return false;
}

export const COMMAND_RULES: readonly CommandRule[] = [
  {
    id: "eval",
    category: "shell-escape",
    why: "runs a string as a command, which hides that command from every check",
    matches: (p) => EVAL_BINS.has(p.bin),
  },
  {
    id: "pipe-into-shell",
    category: "shell-escape",
    why: "runs whatever the previous command printed as a script",
    matches: (p) => p.piped && readsScriptFromStdin(p),
  },
  {
    // awk's own pipe-to-command (`print | "sh"`) inside its program text.
    id: "awk-pipe-into-shell",
    category: "shell-escape",
    why: "pipes its output into a shell from inside the awk program",
    matches: (p) => AWK_BINS.has(p.bin)
      && p.words.slice(p.at + 1).some((a) => /\|\s*"\s*(?:\S*\/)?(?:ba|z|da|k|a)?sh\b/.test(a)),
  },
];

export type CommandRuleVerdict =
  | { kind: "rule"; rule: CommandRule; bin: string }
  | { kind: "too-deep" };

/** The first rule the command breaks, or null. Nesting past the walk's depth is
 *  refused outright: a body the rules cannot see is not a body they allowed. */
export function findCommandRuleHit(command: string): CommandRuleVerdict | null {
  const walk = commandPositions(command);
  for (const p of walk.positions) {
    for (const rule of COMMAND_RULES) {
      if (rule.matches(p)) return { kind: "rule", rule, bin: p.words[p.at] };
    }
  }
  return walk.tooDeep ? { kind: "too-deep" } : null;
}

export const TOO_DEEP_REASON =
  `Blocked: shells nested more than ${MAX_SHELL_NESTING - 1} deep (a shell -c body inside another). ` +
  "Run the inner command directly.";
