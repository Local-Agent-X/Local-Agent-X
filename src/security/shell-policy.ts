import type { SecurityDecision } from "../types.js";
import { USER_HINTS } from "../types.js";
import { countTopLevelPipes } from "../tools/shell-translate.js";
import { BLOCKED_COMMANDS, BROWSER_OPEN_CMDS } from "./shell-rules.js";
import {
  detectObfuscation,
  detectScriptWrite,
  stripQuotedSpans,
  detectInterpreterEscape,
  detectNetworkClientArgv0,
  detectInlineNetwork,
} from "./shell-detectors.js";

// Re-exported for the existing public surface (importers reference it from
// "./shell-policy.js"); the implementation now lives in shell-detectors.ts.
export { detectObfuscation };

export function evaluateShellCommand(command: string): SecurityDecision {
  // Obfuscation detection
  try {
    const obfuscationResult = detectObfuscation(command);
    if (obfuscationResult) {
      return { allowed: false, reason: obfuscationResult, userHint: USER_HINTS.commandShell };
    }
  } catch {
    // Don't crash on obfuscation check failure — allow the command through
  }

  // Reject launching a URL in the system browser — route to the browser tool
  // (CDP attach + audit) instead. Checked here so the specific message wins
  // over the generic denylist hit on `open`/`xdg-open`, and so every
  // bash-spawning path (bash, process_start) enforces it.
  if (BROWSER_OPEN_CMDS.test(command)) {
    return {
      allowed: false,
      reason: "Cannot open URLs in the system browser — use the browser tool instead.",
      userHint: USER_HINTS.commandShell,
    };
  }

  // Block heredoc + inline-script writes (forces use of write/edit tools)
  const scriptWriteResult = detectScriptWrite(command);
  if (scriptWriteResult) {
    return { allowed: false, reason: scriptWriteResult, userHint: USER_HINTS.commandShell };
  }

  // C3-13: argv-aware interpreter-escape (perl/ruby/php inline eval with
  // intervening flags — `perl -w -e`, `ruby -rsocket -e`).
  const interpEscape = detectInterpreterEscape(command);
  if (interpEscape) {
    return { allowed: false, reason: interpEscape, userHint: USER_HINTS.commandShell };
  }

  // C3-12/C3-14: network clients gated by argv[0] basename (fetch/http/xh/…),
  // so `git fetch` is unaffected but a leading `http example.com` is blocked.
  const netClient = detectNetworkClientArgv0(command);
  if (netClient) {
    return { allowed: false, reason: netClient, userHint: USER_HINTS.commandShell };
  }

  // C3-17: raw socket / low-level network module use inside node -e / python -c
  // (and perl/ruby) inline bodies — the same arbitrary egress as a network CLI.
  const inlineNet = detectInlineNetwork(command);
  if (inlineNet) {
    return { allowed: false, reason: inlineNet, userHint: USER_HINTS.commandShell };
  }

  // Block dangerous shell metacharacters (command chaining, subshells, command substitution)
  // Allow: | (pipes, controlled below), > < (redirects), * ? (globs)
  // Block dangerous shell metacharacters — platform-aware
  if (process.platform === "win32") {
    // PowerShell: backtick is the escape char, ${} is variable syntax, {} is script blocks — all normal
    // Only block actual dangerous patterns: Invoke-Expression, iex, & (call operator at start)
    if (/\r\n/.test(command)) {
      return { allowed: false, reason: "Blocked: multi-line commands not allowed.", userHint: USER_HINTS.commandShell };
    }
  } else {
    // Bash: block backtick, $(), ${} (command substitution). Kept on the raw
    // command — backtick/$() inside double quotes are still expanded by bash.
    if (/[`\r\n]/.test(command) || /\$\(/.test(command) || /\$\{/.test(command)) {
      return { allowed: false, reason: "Blocked: shell metacharacters detected (backtick or command substitution).", userHint: USER_HINTS.commandShell };
    }
    // Block ; (sequential chaining) and single & (background) but allow && and ||.
    // These are only separators OUTSIDE quotes — a `;` inside
    // `python -c "import json; ..."` is literal to the shell, not a chain.
    const unquoted = stripQuotedSpans(command);
    if (/;/.test(unquoted) || /(?<![&|])&(?![&|])/.test(unquoted)) {
      return { allowed: false, reason: "Blocked: use && instead of ; for chaining, and don't background processes with &.", userHint: USER_HINTS.commandShell };
    }
  }

  // Allow at most 5 pipes (e.g., `ls | grep foo | sort | head | cut`).
  // Quote-aware: literal `|` inside `"..."` / `'...'` doesn't count, and
  // `||` is a chain operator not a pipe. Naive matching false-positived
  // benign commands like `echo "a|b|c|d|e|f"` against this 5-pipe cap.
  const pipeCount = countTopLevelPipes(command);
  if (pipeCount > 5) {
    return {
      allowed: false,
      reason: `Blocked: too many pipes (${pipeCount}). Maximum 5 pipes allowed per command.`,
      userHint: USER_HINTS.commandShell,
    };
  }

  // Check every segment of a piped command against blocked patterns
  const segments = command.split("|").map((s) => s.trim());
  for (const segment of segments) {
    for (const pattern of BLOCKED_COMMANDS) {
      if (pattern.test(segment)) {
        return {
          allowed: false,
          reason: `Blocked: pipe segment matches dangerous pattern.`,
          userHint: USER_HINTS.commandShell,
        };
      }
    }
  }

  // Also check the full command (catches patterns that span pipes)
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Blocked: command matches dangerous pattern.`,
        userHint: USER_HINTS.commandShell,
      };
    }
  }

  return { allowed: true, reason: "Shell command allowed" };
}
