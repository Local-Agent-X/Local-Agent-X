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

export type TargetShell = "powershell-51" | "pwsh-7" | "bash";

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
