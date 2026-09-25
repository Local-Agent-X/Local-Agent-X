// Cross-platform shell command translation. The agent emits POSIX-style
// commands (`cd x && grep y`, `... 2>/dev/null`); on Mac and Linux those
// run as-is, on Windows with PowerShell 7+ they also run as-is, but on
// Windows with PowerShell 5.1 (the box-stock fallback) the chain operators
// `&&` and `||` are parser errors and `/dev/null` doesn't exist. Without
// translation the user sees:
//
//   + ~~ The token '&&' is not a valid statement separator in this version.
//
// — a technical error they can't action. Real failure (2026-05-23):
// grok-code-fast-1 emitted `cd workspace/apps/x && grep -r
// speed .` 14 times in one turn; PS 5.1 rejected every call, the model
// couldn't make progress, the no-progress middleware aborted the turn.
//
// This module translates *transparently* — model still writes POSIX, we
// rewrite to PS 5.1-equivalent before spawn. Only fires on the PS 5.1
// fallback path; pwsh 7+ and bash skip it (they handle natively).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { shellWords } from "../tool-execution/shell-delete-targets.js";

export type TargetShell = "powershell-51" | "pwsh-7" | "bash";

// The PowerShell cmdlets agents most often misfire into the bash tool, with the
// POSIX equivalent to reach for instead (or a purpose-built LAX tool).
const CMDLET_POSIX: Record<string, string> = {
  "Get-ChildItem": "ls (or the glob tool)",
  "Get-Content": "cat (or the read tool)",
  "Select-String": "grep (or the grep tool)",
  "Select-Object": "head / tail / sed -n",
  "Where-Object": "grep / awk",
  "ForEach-Object": "a for loop or xargs",
  "Set-Content": "the write tool (or a > redirect)",
  "Copy-Item": "cp",
  "Remove-Item": "rm",
  "Test-Path": "test -e",
  "Write-Output": "echo",
};

/** When a POSIX-bash run fails because the model sent a PowerShell cmdlet
 *  (`Get-ChildItem: command not found`), return a one-line steer to the right
 *  tool. The Verb-Noun-with-hyphen shape is unique to cmdlets — bash builtins
 *  and binaries are lowercase — so this never fires on a genuine bash command.
 *  Returns null when the failure isn't a cmdlet misfire. */
export function powershellCmdletHint(stderr: string): string | null {
  const m = stderr.match(/\b([A-Z][a-z]+-[A-Z][a-zA-Z]+)\b\s*:\s*command not found/);
  if (!m) return null;
  const cmdlet = m[1];
  const posix = CMDLET_POSIX[cmdlet];
  // Name only what exists and what is safe to steer toward. This used to say
  // "call the PowerShell tool" — there is no such tool. Its replacement for a
  // day pointed at `powershell -NoProfile -Command "…"` through bash, and the
  // model used that wrapper to run `python -c` past the inline-eval block
  // (muse, 2026-09-17): the shell policy does not look inside a nested
  // interpreter's command string. The hint must never advertise a wrapper.
  return `'${cmdlet}' is a PowerShell cmdlet, but the bash tool runs POSIX sh. ` +
    (posix ? `Use \`${posix}\` instead.` : "Use the POSIX equivalent instead.");
}

/**
 * A Windows path with backslashes, sent to POSIX bash, arrives with every
 * backslash consumed as an escape: `C:\Users\peter\x.exe` becomes
 * `C:Userspeterx.exe`, and bash's error names only that mangled word. A drive
 * letter glued straight to a name is the fingerprint — a real path has a slash
 * after the colon. Seen in both muse sessions on 2026-09-16, where the model
 * could not tell why a path it had just listed "did not exist".
 *
 * Not rewritten automatically: a backslash is a legitimate escape in bash, and
 * guessing which ones were meant as separators would corrupt real commands.
 */
export function windowsPathHint(stderr: string): string | null {
  const m = stderr.match(/(?:^|[\s'"`:])([A-Za-z]:[A-Za-z][^\s'"`:]*)/);
  if (!m || !/command not found|No such file or directory|cannot access/.test(stderr)) return null;
  return `\`${m[1]}\` looks like a Windows path whose backslashes bash consumed as escapes. ` +
    `In the bash tool write it with forward slashes (\`C:/Users/...\`) or quote it in single quotes.`;
}

/**
 * The bash tool runs INSIDE the workspace, and every prompt and file tool
 * teaches the `workspace/apps/x` spelling for the same files — the file tools
 * strip that leading segment (workspace/paths.ts stripWorkspacePrefix), bash
 * cannot, so `rm -r workspace/client-data/build-cache` lands on
 * `<workspace>/workspace/…`, fails "No such file", and the model concludes the
 * folder is already gone, hand-writes what a CLI should have produced, or acts
 * on a bogus error (op-outcomes 2026-09-24: seven of 26 kept failure stores).
 *
 * Not rewritten: a command is never edited on the model's behalf. The hint
 * names the doubled path and the spelling that works. Silent when the
 * workspace really has a `workspace/` child, so a genuine miss stays a miss.
 */
export function workspacePrefixHint(stderr: string, cwd: string, exists: (p: string) => boolean = existsSync, command = ""): string | null {
  if (exists(join(cwd, "workspace"))) return null;
  const fromStderr = (): string | null => {
    if (!/No such file or directory|cannot access|Cannot find module|not found/.test(stderr)) return null;
    const rel = stderr.match(/(?:^|[\s'"`:(])(?:\.\/)?(workspace[/\\][^\s'"`:)]*)/);
    const doubled = stderr.match(/[/\\]workspace[/\\]workspace[/\\]([^\s'"`:)]*)/);
    return rel ? rel[1].replace(/^workspace[/\\]/, "") : doubled ? doubled[1] : null;
  };
  // `rm -rf workspace/x`, `ls workspace/x 2>/dev/null` — -f and redirects
  // leave stderr empty and exit 0, so the failure is invisible there; the
  // command's own word is the signal, when the un-prefixed path really exists.
  const fromCommand = (): string | null => {
    for (const w of shellWords(command)) {
      const m = w.match(/^(?:\.\/)?workspace[/\\](.+)$/);
      if (m && exists(join(cwd, m[1]))) return m[1];
    }
    return null;
  };
  const tail = fromStderr() ?? fromCommand();
  if (tail === null) return null;
  const shown = tail.replace(/\\/g, "/");
  return `\`workspace/${shown}\` resolved to \`${join(cwd, "workspace", shown).replace(/\\/g, "/")}\`, which does not exist, so nothing there was read or changed: ` +
    `the bash tool already runs inside the workspace (\`${cwd.replace(/\\/g, "/")}\`), so write the path without the leading ` +
    `\`workspace/\` — \`${shown}\`. (The file tools accept both spellings; bash does not.)`;
}

export function detectTargetShell(shellPath: string): TargetShell {
  const base = shellPath.toLowerCase().replace(/\\/g, "/").split("/").pop() || "";
  if (base === "pwsh.exe" || base === "pwsh") return "pwsh-7";
  if (base === "powershell.exe") return "powershell-51";
  return "bash";
}

export function translateForShell(cmd: string, target: TargetShell): string {
  if (target !== "powershell-51") return cmd;
  return translateAndOrChain(translateRedirects(cmd));
}

// /dev/null is POSIX-only. PS 5.1 uses $null. Replacement is safe outside
// of quoted strings — no one writes a literal "/dev/null" in command output
// often enough to worry, and matching with required leading whitespace
// rules out edge cases like file paths that happen to contain the substring.
function translateRedirects(cmd: string): string {
  return cmd
    .replace(/(\s|^)2>\s*\/dev\/null\b/g, "$12>$$null")
    .replace(/(\s|^)1>\s*\/dev\/null\b/g, "$11>$$null")
    .replace(/(\s|^)>\s*\/dev\/null\b/g, "$1>$$null");
}

// Split on top-level && / || (skipping occurrences inside quotes), then
// re-emit as nested PS if-blocks that mirror bash short-circuit semantics.
// Right-to-left build keeps nesting correct for pure-&& and pure-|| chains
// (the 95%+ case for agent-emitted commands). Mixed `a && b || c` chains
// diverge from bash semantics — bash runs c when a fails, this won't —
// but agents rarely emit mixed chains and the divergence is bounded.
function translateAndOrChain(cmd: string): string {
  const parts = splitChains(cmd);
  if (parts.length === 1) return cmd;
  let result = parts[parts.length - 1].text;
  for (let i = parts.length - 2; i >= 0; i--) {
    const sep = parts[i].sep;
    const me = parts[i].text;
    if (sep === "&&") {
      result = `${me}; if ($?) { ${result} }`;
    } else if (sep === "||") {
      result = `${me}; if (-not $?) { ${result} }`;
    }
  }
  return result;
}

// Count `|` chars that act as actual shell pipes — outside single- and
// double-quoted strings. Naive `command.match(/\|/g)` over-counts when the
// command contains a quoted string with a literal `|`, which trips the
// 5-pipe security cap on benign commands like `echo "a|b|c|d|e|f|g"`.
// Used by the shell-policy gate; the quote-tracking logic mirrors
// splitChains() below.
export function countTopLevelPipes(cmd: string): number {
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (c === "|") {
      // Don't count `||` as a pipe — it's a logical-OR chain operator.
      if (cmd[i + 1] === "|") { i++; continue; }
      count++;
    }
  }
  return count;
}

type ChainPart = { text: string; sep: "&&" | "||" | null };

function splitChains(cmd: string): ChainPart[] {
  const parts: ChainPart[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" && !inDouble) { inSingle = !inSingle; current += c; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; current += c; continue; }
    if (!inSingle && !inDouble) {
      const two = cmd.substr(i, 2);
      if (two === "&&" || two === "||") {
        parts.push({ text: current.trim(), sep: two as "&&" | "||" });
        current = "";
        i++;
        continue;
      }
    }
    current += c;
  }
  parts.push({ text: current.trim(), sep: null });
  return parts;
}
