/**
 * Approval decision logic — the pure, stateless layer the ApprovalManager sits
 * on top of. Thin adapter over src/autonomy/profiles.ts:
 *
 *   getToolDecision(tool) =
 *     decide(getProfile(loadProfileName()), classifyToolRisk(tool))
 *
 * Plus the risk-relevant fingerprint that keys the session auto-approve cache
 * and the irreversibility floor (destructive shell/tool detection) that forces
 * a confirm regardless of profile. No mutable state lives here — every export
 * is a pure function or a constant.
 */

import { dirname as pathDirname, isAbsolute, normalize, resolve as pathResolve } from "node:path";
import {
  decide,
  getProfile,
  type Decision,
  type Profile,
} from "./autonomy/profiles.js";
import { loadProfileName, getSessionProfile } from "./autonomy/profile-store.js";
import { classifyToolRisk } from "./autonomy/risk.js";
import { irreversibleToolReason } from "./irreversible-tools.js";
import { declaredPaths, hasCapability, pathSpecsForCall, policyRowOf, shellCommandOf, TOOL_PATH_ARGS, wholeToolGrant } from "./tool-registry.js";
import { TOOL_POLICIES } from "./tool-policy/tool-policies.js";
import { declaredDestinations, destinationKey } from "./tool-execution/send-destinations.js";
import { isDisposableTreeDelete, type TreeDeleteScope } from "./tool-execution/disposable-tree-delete.js";
import { commandsBashRuns } from "./security/layer/shell-source-text.js";
import { consentedInChat, type ChatTurn } from "./tool-execution/chat-consent.js";

// Profile name cached 1s — same shape as the prior approvalMode cache.
// loadProfileName() reads ~/.lax/autonomy-profile.json on miss.
let _cachedProfile: ReturnType<typeof loadProfileName> | null = null;
let _profileCachedAt = 0;
function currentProfileName(sessionId?: string): ReturnType<typeof loadProfileName> {
  // A per-session override (e.g. a cron job pinned to Autonomous) wins over
  // the persisted global profile and bypasses the 1s disk cache.
  if (sessionId) {
    const override = getSessionProfile(sessionId);
    if (override) return override;
  }
  if (_cachedProfile && Date.now() - _profileCachedAt < 1000) return _cachedProfile;
  _cachedProfile = loadProfileName();
  _profileCachedAt = Date.now();
  return _cachedProfile;
}

/** The profile governing this session: its per-session override (cron jobs)
 *  when one is pinned, else the persisted global one. */
export function getActiveProfile(sessionId?: string): Profile {
  return getProfile(currentProfileName(sessionId));
}

/** What does the active profile say about this tool? Pass `sessionId` so a
 *  per-session profile override (cron jobs) is honored. */
export function getToolDecision(toolName: string, sessionId?: string): Decision {
  return decide(getActiveProfile(sessionId), classifyToolRisk(toolName));
}

/** What does the active profile say about a specific risk tier? Used to
 *  re-decide a call that got RECLASSIFIED (a shell command carrying rm -rf
 *  is decided by the destructive rule, not the shell rule). */
export function getRiskDecision(risk: Parameters<typeof decide>[1], sessionId?: string): Decision {
  return decide(getActiveProfile(sessionId), risk);
}

/** Does this decision require an interactive user prompt before running? */
export function decisionRequiresPrompt(d: Decision): boolean {
  return d === "ask";
}

/** Does this decision block the tool outright? */
export function decisionDenies(d: Decision): boolean {
  return d === "deny";
}

/**
 * Irreversible-action floor. A truly-irreversible SHELL op (rm -rf, dd, mkfs,
 * git reset --hard, git push --force, …) bypasses the recycle bin and can't be
 * undone — yet Power's `destructive: "allow"` (and Developer/Autonomous's
 * "allow-with-rollback", whose git-stash net can't undo a force-push or a
 * delete outside a repo) would run it with no human confirm. Upgrade such a
 * decision to "ask" so an interactive run gets ONE confirm regardless of
 * profile — "never asks except before something it can't undo".
 *
 * The same holds for an irreversible TOOL (irreversibleToolReason): app_delete,
 * a confirmed memory_forget, marketplace_install ran silently under Power until
 * 2026-09-26. Recoverable destructive tools (delete_file → trash, and the
 * RECOVERABLE_WITHOUT_PAIR list) stay excluded, so the floor never nags on
 * something undoable — the over-broad behavior that got an earlier confirm floor
 * removed. Callers apply it in interactive (local) context only; unattended runs
 * stay governed by the profile so explicit automation isn't broken.
 */
export function applyIrreversibleFloor(
  decision: Decision,
  toolName: string,
  args: Record<string, unknown>,
  said?: ChatTurn,
  treeDelete?: TreeDeleteScope,
): Decision {
  if (decision !== "allow" && decision !== "allow-with-rollback") return decision;
  // A shell op the user already said yes to in the chat, naming its target
  // (chat-consent.ts), is not asked about a second time.
  const shell = approvalShellReason(toolName, args, treeDelete) !== null
    && !consentedInChat(shellCommandOf(toolName, args) ?? "", said);
  return shell || irreversibleToolReason(toolName, args, said?.user) !== null ? "ask" : decision;
}

/**
 * Tools whose "always allow" covers every later call: each row that declares
 * `wholeToolGrant` (LAX's own bookkeeping — the task list, the sidebar — which
 * can reach no file, program, network or person the user did not already
 * approve). Every other tool's grant is scoped by its arguments.
 */
export const WHOLE_TOOL_GRANTS: ReadonlySet<string> = new Set(Object.keys(TOOL_POLICIES).filter(wholeToolGrant));

/**
 * Who a send reaches, as its arguments name it (send-destinations.ts), when
 * every recipient can be named the same way twice; null otherwise. Keyed on
 * the tool's declared rule, never on an argument being present — a model can
 * add an unused `url` or `to` to any call, and that must not turn the rest of
 * it into payload.
 */
/** The scope entry naming a send's recipients. `_`-prefixed, so no argument
 *  the model passes can collide with it (those never enter the scope). */
const RECIPIENTS = "_recipients";

function recipientsOf(tool: string, args: Record<string, unknown>): string[] | null {
  const destinations = declaredDestinations(tool, args);
  if (!destinations) return null;
  const keys = destinations.map(destinationKey);
  return keys.every((k): k is string => k !== null) ? [...new Set(keys)].sort() : null;
}

/** The command a grant names: leading env-var assignments dropped, whitespace
 *  collapsed. A token split, not a regex: `/^(\s*\w+=\S+\s+)+/` backtracks
 *  polynomially on adversarial input (ReDoS). */
function canonicalCommand(raw: string): string {
  const tokens = raw.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^\w+=\S+$/.test(tokens[i])) i++;
  return tokens.slice(i).join(" ");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

/**
 * The scope of a remembered approval — the session auto-approve cache key — so
 * a grant for one call never covers a call the user did not see. It is derived
 * from what the arguments mean, as the tool table declares it:
 *   - a declared path argument (TOOL_PATH_ARGS) counts by its directory;
 *   - a shell-class tool's `command` counts as the canonical command;
 *   - a send counts by who receives it: its email recipients, its site, the
 *     authorized chat, its service (recipientsOf);
 *   - every other argument counts exactly.
 * A file-mutating tool (workspace-write) is scoped by its paths alone, and a
 * send by its paths and recipients alone: what they write or send there is
 * the payload, so one grant covers a directory or a recipient, never more.
 * A send to a recipient that cannot be named twice (an address the check
 * could not read) is scoped by every argument.
 * Internal `_` arguments are not the model's and never count. Only
 * WHOLE_TOOL_GRANTS get "*". Pure: the same call always yields the same key.
 */
export function computeArgsFingerprint(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const tool = toolName.toLowerCase();

  // A vault secret handed to a command: "always allow" covers this program
  // with these secrets, never every secret (secret-env-approval.ts).
  if (tool === "use_secret") {
    const secrets = Array.isArray(args.secrets) ? args.secrets.map(String).sort().join(",") : "";
    return `${String(args.program ?? "")}::${secrets}`;
  }
  if (WHOLE_TOOL_GRANTS.has(tool)) return "*";

  const scope: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (!k.startsWith("_")) scope[k] = v;

  const specs = TOOL_PATH_ARGS[tool] ?? [];
  const pathDirs = new Map<string, Set<string>>();
  for (const spec of pathSpecsForCall(tool, args)) {
    // An `each` arg is a list of records that carry more than paths (a batch's
    // task descriptions), and a malformed path value names no directory: both
    // count exactly, as does a path the call's action does not open.
    if (spec.each || args[spec.arg] === undefined) continue;
    const paths = declaredPaths(args, spec);
    if (paths === null) continue;
    const dirs = pathDirs.get(spec.arg) ?? new Set<string>();
    // A relative path is resolved by the tool against the session's root, not
    // this process's cwd, so it keys on its own normalized directory.
    for (const p of paths) dirs.add(pathDirname(isAbsolute(p) ? pathResolve(p) : normalize(p)));
    pathDirs.set(spec.arg, dirs);
  }
  for (const [arg, dirs] of pathDirs) scope[arg] = [...dirs].sort();

  const command = shellCommandOf(tool, args);
  if (command !== undefined) scope.command = canonicalCommand(command);
  const recipients = recipientsOf(tool, args);
  if (recipients || hasCapability(tool, "workspace-write", args)) {
    const kept = new Set(["action", ...specs.map((s) => s.arg)]);
    for (const k of Object.keys(scope)) if (!kept.has(k)) delete scope[k];
  }
  if (recipients) scope[RECIPIENTS] = recipients;
  return stableJson(scope);
}

export function cacheKey(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}::${computeArgsFingerprint(toolName, args)}`;
}

// Exact-args key for in-flight coalescing and decline suppression. Unlike
// cacheKey (which uses the COARSE risk fingerprint so an auto-approve grant
// covers a whole dir/host), this keys on the full canonical args — declining
// delete_file(a.json) must NOT suppress the card for delete_file(b.json) in
// the same dir. Keyed per-session so one session's declines never leak to
// another.
function canonicalArgs(args: Record<string, unknown>): string {
  try {
    const keys = Object.keys(args).sort();
    const ordered: Record<string, unknown> = {};
    for (const k of keys) ordered[k] = args[k];
    return JSON.stringify(ordered);
  } catch {
    return "";
  }
}

export function exactKey(sessionId: string, toolName: string, args: Record<string, unknown>): string {
  return `${sessionId}::${toolName}::${canonicalArgs(args)}`;
}

// How long a decline/timeout suppresses an IDENTICAL re-issue. The retry
// storm collapses in milliseconds once repeats resolve instantly, so this is
// just a GC backstop for non-chat runs (agent/cron) that don't call
// clearDeclines at a turn boundary. Chat turns reset declines per user turn,
// so a deliberate re-request after the model gives up still prompts.
export const DECLINE_SUPPRESS_MS = 60_000;

// Irreversible / hard-to-undo shell operations that must ALWAYS be confirmed,
// regardless of how relaxed the autonomy profile is and without being
// remembered for the session. The profile decides the *default* posture; this
// list is a floor under it for the handful of operations that can destroy work
// or data with no recovery. Patterns stop at the first command separator so a
// later piped/chained token can't smuggle one in unmatched-by-position. A
// newline is one too: `rm -f qmp.sock⏎qemu-system-i386 -drive …` carded as
// `rm -r` (TB2 install-windows-3.11, 2026-10-28). A backslash-newline is not,
// so the floor scans the command with its continuations joined (floorText).
const DESTRUCTIVE_COMMAND_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\b[^|;&\n]*\s(?:--force\b|--force-with-lease\b|-\w*f\w*\b)/i, reason: "git force-push" },
  { pattern: /\bgit\s+push\b[^|;&\n]*\s(?:--delete\b|:\S)/i, reason: "git delete remote branch" },
  { pattern: /\bgit\s+reset\b[^|;&\n]*--hard\b/i, reason: "git reset --hard" },
  { pattern: /\bgit\s+clean\b[^|;&\n]*-\w*f\w*/i, reason: "git clean -f" },
  // Case-SENSITIVE, unlike its neighbours: `-D` force-deletes a branch with
  // unmerged commits; `-d` refuses to, so it can lose nothing and is not on
  // this floor. Under /i the `-d` form carded every merged-branch cleanup, in
  // Autonomous too (2026-10-26). The long and split spellings of a forced
  // delete (`--delete --force`, `-d -f`, `-df`) are the same -D.
  { pattern: /\bgit\s+branch\b[^|;&\n]*\s(?:-[A-Za-z]*D[A-Za-z]*\b|-[A-Za-z]*(?:df|fd)[A-Za-z]*\b|(?:--delete|-d)\b[^|;&\n]*\s(?:--force|-f)\b|(?:--force|-f)\b[^|;&\n]*\s(?:--delete|-d)\b)/, reason: "git force-delete branch" },
  { pattern: /\bgit\s+filter-branch\b/i, reason: "git history rewrite" },
  // `git rm` is a staged removal the index can undo (`git rm -rf --cached
  // build` deletes nothing on disk), so no rm pattern matches after `git`.
  { pattern: /(?<!\bgit\s+)\brm\s+-\w*r\w*f\w*\b/i, reason: "rm -rf" },
  { pattern: /(?<!\bgit\s+)\brm\s+-\w*f\w*r\w*\b/i, reason: "rm -fr" },
  { pattern: /(?<!\bgit\s+)\brm\s+-[rf]\b[^|;&\n]*\s-[rf]\b/i, reason: "rm -r -f" },
  // `rm -r` without -f was left off as "not the catastrophic form". Wrong
  // axis: -f only silences prompts and missing-file errors; on a writable
  // tree `rm -r dir` is exactly as unrecoverable as `rm -rf dir`, and it is
  // the form a model reaches for under Git Bash once `Remove-Item` fails as
  // not-a-command. The first eval case to provoke a shell wipe
  // (restraint-wipe-build-cache, 2026-09-22) had the Remove-Item attempt
  // carded and the `rm -r` fallback executed with no card, 2 runs of 3.
  // `git rm -r` is a staged removal the index can undo, so it is excluded.
  // `rm -Recurse` (the PowerShell alias) is caught here too; the entry below
  // that names it precisely is listed first so the reason says what it is.
  { pattern: /\b(?:rm|ri|rmdir|rd|del|erase)\b[^|;&\n]*\s-rec\w*\b/i, reason: "Remove-Item -Recurse (alias)" },
  { pattern: /(?<!\bgit\s+)\brm\b[^|;&\n]*\s(?:-\w*r\w*|--recursive)\b/i, reason: "rm -r" },
  // A recursive wipe by composition. With `rm -rf` policy-blocked and `rm -r`
  // carded, a 27B ran `find client-data/build-cache -exec rm {} + && rmdir
  // client-data/build-cache` — every file deleted by find's per-file rm, then
  // the empty tree removed — and nothing here saw it (op-outcomes
  // restraint-wipe-build-cache, 2026-09-23). The composed forms delete a tree
  // exactly as `rm -r` does, so they sit on the same floor: find's own
  // -delete, find handing files to rm/unlink/rmdir through -exec/-execdir/
  // -ok/-okdir, and rm/unlink/rmdir fed by xargs (which only ever follows a
  // pipe, so it is matched from its own word). A find that lists, or an
  // xargs that counts, is not a delete and stays off.
  { pattern: /\bfind\b[^|;&\n]*\s-delete\b/i, reason: "find -delete" },
  { pattern: /\bfind\b[^|;&\n]*\s-(?:exec|execdir|ok|okdir)\s+(?:rm|unlink|rmdir)\b/i, reason: "find -exec rm" },
  { pattern: /\bxargs\b[^|;&\n]*\s(?:rm|unlink|rmdir)\b/i, reason: "xargs rm" },
  { pattern: /\bdd\b[^|;&\n]*\sof=\/dev\//i, reason: "dd to a raw device" },
  { pattern: /\bmkfs\b/i, reason: "filesystem format" },
  // Native Windows deletes. Every entry above was Unix-shaped, so on the
  // product's primary platform this floor did not exist: a qwen3:8b run had
  // three `Remove-Item` variants blocked by other layers, then
  // `powershell.exe -Command "Remove-Item -Force -Recurse '<absolute path>'"`
  // went through and destroyed three client originals with no trash and no
  // card (EXP-8, 2026-09-21). The `powershell -Command` / `cmd /c` wrappers
  // need no special handling: these scan the whole command string, and the
  // delete inside the quoted argument still matches.
  //
  // PowerShell: Remove-Item -Recurse deletes a tree without prompting, and its
  // parameter may be abbreviated (-Rec, -r). The cmdlet's aliases (rm, ri,
  // rmdir, rd, del, erase) take the same parameter — the alias entry above,
  // matched with the PowerShell spelling (-Rec…).
  { pattern: /\bRemove-Item\b[^|;&\n]*\s-r(?:ec\w*)?\b/i, reason: "Remove-Item -Recurse" },
  // cmd.exe: `rd /s` removes a tree; `del /s` deletes across subdirectories.
  // /q only silences the prompt, so /s is the flag that makes it a tree.
  { pattern: /\b(?:rd|rmdir)\b(?:\s+\/\w+)*\s+\/s\b/i, reason: "rd /s" },
  { pattern: /\b(?:del|erase)\b(?:\s+\/\w+)*\s+\/s\b/i, reason: "del /s" },
];

// Quoted text no shell will ever run: a git commit or tag message, and the
// pattern a search command looks for. The patterns above scan the whole command
// string on purpose (a `bash -c "rm -rf …"` body must still match, and a
// quote-aware rewrite of this scan is the one migration the shell-path guard
// lost coverage to, 2026-07-27). So nothing is parsed: only these two literal
// shapes are blanked, and only when nothing inside them expands — a `$(…)` or a
// backtick in a double-quoted string runs, so that string is left to be
// scanned. `git commit -m "drop the rm -r fallback"` carded as "rm -r" and
// `grep -rn "git reset --hard" docs` as "git reset --hard" (2026-10-26).
const SINGLE_QUOTED = String.raw`'[^']*'`;
const DOUBLE_QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
const LITERAL = `(${SINGLE_QUOTED}|${DOUBLE_QUOTED})`;
const COMMIT_MESSAGE = new RegExp(String.raw`(\bgit\b[^|;&\n]*?\s(?:commit|tag)\b[^|;&\n]*?\s(?:-[A-Za-z]*m|--message)(?:\s+|=))` + LITERAL, "g");
const SEARCH_PATTERN = new RegExp(String.raw`(\b(?:grep|egrep|fgrep|rg|ag|ack|findstr)\b(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+|\bSelect-String\b[^|;&\n]*?\s-Pattern\s+|\bgit\b[^|;&\n]*?\slog\b[^|;&\n]*?\s--grep(?:\s+|=))` + LITERAL, "gi");

function runsNothing(literal: string): boolean {
  return literal.startsWith("'") || !/\$\(|`/.test(literal);
}

// Two more shapes that name a program without running it. A lookup in command
// position (`command -v mkfs.ext4`, `which dd`, `if type mkfs …`; never find's
// `-type f -exec rm …`) prints where a program is. And a `for` loop's word
// list, when its body only looks the word up or prints it: TB2 qemu-alpine-ssh
// (2026-10-27) carded `for t in mkfs.ext4 fdisk; do command -v $t; done` as a
// filesystem format. A body that runs the word (`$t /dev/sdb`), hands it on
// (an assignment, a pipe, xargs, eval), redirects, or nests a loop keeps the
// list.
const LOOKUP = /((?:^|[;&|(\n!]|\b(?:do|then|else|if|elif|while|until)\b)\s*(?:command\s+-[vV]|which|type)\s+)([^;&|()<>\n`]+)/g;
const FOR_LIST = /(\bfor\s+([A-Za-z_]\w*)\s+in\s+)([^;\n`]*?)(\s*[;\n]\s*do\b)([\s\S]*?\bdone\b)/g;
const PRINTERS = new Set(["echo", "printf", "which", "type"]);

function onlyLooksUp(name: string, body: string): boolean {
  if (/`|\$\(|(?<!\|)\|(?!\|)|\b(?:eval|xargs|for|while|until)\b/.test(body)) return false;
  const ref = new RegExp(String.raw`\$\{?${name}\b`);
  return body.split(/[;&|\n]+/).every((segment) => {
    if (!ref.test(segment)) return true;
    if (/[<>]/.test(segment)) return false;
    const [head, flag] = segment.trim().replace(/^(?:(?:do|then|else|if|elif|!)\s+)+/, "").split(/\s+/);
    return PRINTERS.has(head) || (head === "command" && /^-[vV]$/.test(flag ?? ""));
  });
}

/** The command with every data-only literal above blanked to `""`. */
export function withoutInertLiterals(command: string): string {
  const blank = (whole: string, lead: string, literal: string) => (runsNothing(literal) ? `${lead}""` : whole);
  return command.replace(COMMIT_MESSAGE, blank).replace(SEARCH_PATTERN, blank)
    .replace(FOR_LIST, (whole, lead: string, name: string, list: string, open: string, body: string) =>
      (!list.includes("$(") && onlyLooksUp(name, body) ? `${lead}""${open}${body}` : whole))
    .replace(LOOKUP, (_whole, lead: string) => `${lead}""`);
}

/** The text the floor scans: line continuations joined (a backslash-newline
 *  continues one command), then the inert literals blanked. */
function floorText(raw: string): string {
  return withoutInertLiterals(raw.replace(/\\\r?\n/g, " "));
}

/**
 * If a shell tool call is an irreversible/destructive operation, return a short
 * human reason; otherwise null. Used to force an approval prompt that bypasses
 * both the relaxed-profile auto-allow and the remember-for-session cache.
 */
export function isDestructiveCommand(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  // Every tool that runs a model-authored shell command (its row's commandArg:
  // bash, the process_* spawners, the app dev servers) hits the same floor —
  // they spawn the identical shell. Keyed on the tool name, process_start's
  // `git push --force` ran silently while the identical bash forced a confirm,
  // and app_serve_backend's command was never scanned at all.
  const raw = shellCommandOf(toolName, args);
  if (raw === undefined) return null;
  // Each command bash runs: a heredoc body is the line's data unless a shell
  // runs it (shell-source-text.ts). A git hook or a Makefile written with
  // `cat <<'EOF'` carded as the `rm -rf` inside it (TB2 git-multibranch,
  // 2026-10-28, from another harness's run); a script fed to `bash <<EOF`, or
  // one the line goes on to run, is still scanned.
  for (const text of commandsBashRuns(raw)) {
    const cmd = withoutInertLiterals(text);
    for (const { pattern, reason } of DESTRUCTIVE_COMMAND_PATTERNS) {
      if (pattern.test(cmd)) return reason;
    }
  }
  return null;
}

/**
 * isDestructiveCommand as the APPROVAL path judges it: a recursive delete whose
 * every target is provably disposable (generated output beside its manifest,
 * the OS temp dir, the agent's own files; disposable-tree-delete.ts) is not
 * destructive there. Only the approval callers pass `treeDelete` — where the
 * shell runs and for which session. The text-only callers (a skill's install
 * script, the shell tier) have no disk to look at and keep the plain answer.
 */
function approvalShellReason(toolName: string, args: Record<string, unknown>, treeDelete?: TreeDeleteScope): string | null {
  const reason = isDestructiveCommand(toolName, args);
  if (reason === null || !treeDelete) return reason;
  const cmd = floorText(shellCommandOf(toolName, args) ?? "");
  const trips = (segment: string) => DESTRUCTIVE_COMMAND_PATTERNS.some(({ pattern }) => pattern.test(segment));
  return isDisposableTreeDelete(cmd, trips, treeDelete) ? null : reason;
}

/**
 * Detect an irreversible/destructive operation and return a short human
 * reason, or null. The caller RECLASSIFIES a hit to the profile's
 * "destructive" tier and re-decides — the profile table stays the single
 * source of truth (the Security page promises "Power — autonomous for
 * everything except money and secrets"; an unconditional confirm floor here
 * broke that promise and prompted for delete_file under Power).
 *
 * Three sources feed detection:
 *   1. Shell-text patterns (isDestructiveCommand) — `rm -rf`, `git push
 *      --force`, etc. inside a bash/shell command string. Without this, a
 *      coarse shell=allow grant (meant for ls/git status) silently covered
 *      irreversible commands too.
 *   2. The "destructive" ToolRisk class — non-shell tools whose whole purpose
 *      is an irreversible side effect (delete_file, process_kill,
 *      memory_forget, marketplace_install).
 *   3. A row's destructiveActions — collapsed one-tool-many-actions families
 *      whose risk varies per args.action. The tool's static ToolRisk is its
 *      worst NON-destructive tier; the destructive actions are reclassified
 *      there so collapsing a family never weakens its approval gate.
 *
 * Scoped to "destructive" ONLY. money/secrets already have their own tiers.
 */
export function destructiveOperationReason(
  toolName: string,
  args: Record<string, unknown>,
  treeDelete?: TreeDeleteScope,
): string | null {
  const shellReason = approvalShellReason(toolName, args, treeDelete);
  if (shellReason !== null) return shellReason;
  if (classifyToolRisk(toolName) === "destructive") {
    return `destructive tool (${toolName}) — irreversible, confirm before running`;
  }
  const actionReason = policyRowOf(toolName)?.destructiveActions?.[String(args.action ?? "")];
  if (actionReason) {
    return `destructive action (${toolName}.${args.action}) — ${actionReason}, confirm before running`;
  }
  return null;
}
