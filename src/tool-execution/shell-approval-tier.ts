// Risk-tier a shell command by its resolved argv[0] so genuinely-safe commands
// auto-allow WITHOUT an approval prompt (tier-0), while installs / rm / sudo /
// network / out-of-scope commands keep prompting (tier-1) and irreversible ops
// keep the destructive floor (tier-2).
//
// This is the ONE tier classifier. It REUSES the canonical shell primitives
// (resolveRealArgv0 / tokenizeCommand / splitShellSegments / execBasename from
// shell-lex, the keyword/wrapper sets from shell-rules) and the canonical
// destructive detector (isDestructiveCommand from approval-decision) — it never
// forks a parallel bin list.
//
// SAFETY MODEL — tier-0 bypasses ONLY the profile approval PROMPT. It runs in
// the require-approval phase, which is DOWNSTREAM of enforcePolicyPhase's
// runPreDispatch (the SecurityLayer: BLOCKED_COMMANDS denylist, network-client
// argv[0] blocks, egress guards, the mode-aware rm rules, the file-access
// boundary). A command the security layer blocks never reaches this classifier
// as "allowed", so a tier-0 verdict can NEVER resurrect a denied command — it
// only skips the interactive profile prompt for a command that already cleared
// every hard wall. Tier-0 additionally REQUIRES an effectively-confined sandbox
// (getSandboxStatus().confined — false when a guarded selection fell back to the
// host), because without OS-level confinement the structural safety of an
// argv[0] is not enough (the command's children/redirects/expansions escape).
//
// CONSERVATIVE BY MANDATE: a mis-classified install/rm as tier-0 is a security
// regression, so every "in doubt" case returns NOT tier-0. An unknown argv[0],
// an unresolvable command word, a privilege-escalation wrapper (sudo/doas), an
// absolute path outside the user's home, or a package-manager subcommand that
// isn't a pure read/build/test all fall through to the prompt.

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  execBasename,
  resolveRealArgv0,
  splitShellSegments,
  tokenizeCommand,
} from "../security/layer/shell-lex.js";
import { SHELL_KEYWORD_PREFIXES } from "../security/layer/shell-rules.js";
import { isDestructiveCommand } from "../approval-decision.js";
// Canonical always-blocked sensitive-path gate (the SAME checker the file tools
// use — regex catalog for whole cred DIRS like .ssh/.aws/.kube UNIONed with the
// shared credential-file catalog classifySensitivePath). Reused read-only so a
// tier-0-shaped read of a secret can never auto-allow, mode-independent — this
// mirrors the read tool blocking these in ALL file-access modes (incl.
// unrestricted, where the upstream shell-path-guard is a no-op).
import { matchesSensitivePath } from "../security/layer/file-access.js";

export type ShellTier = 0 | 1 | 2;

export interface ShellTierContext {
  /** EFFECTIVE OS-level confinement of the spawn — callers derive it from
   *  getSandboxStatus().confined (false when a guarded selection fell back to
   *  the unconfined host). Tier-0 requires this to be true. */
  sandboxConfined: boolean;
  /** Optional caller signal that the command stays in the workspace/allowed
   *  scope. When explicitly false, forces a prompt. When omitted, the
   *  classifier's own conservative absolute-path scan is the scope gate. */
  inWorkspaceScope?: boolean;
}

// ── SAFE_BIN: read-only + build/test tools whose bare invocation is tier-0 ──
// Plain members: any invocation with this argv[0] is tier-0 (subject to the
// sandbox + scope + escalation gates). Runtimes (node/deno/ruby/python) are
// here because under a confined backend the inline-eval body they may run is
// caged; python carries an extra pip guard below so `python -m pip install`
// still prompts.
const SAFE_BINS = new Set<string>([
  // Read-only filesystem / text inspection
  "ls", "cat", "pwd", "cd", "echo", "find", "grep", "rg", "wc", "head", "tail",
  "sort", "uniq", "cut", "sed", "awk", "file", "stat", "which", "type",
  "dirname", "basename", "realpath", "true", "false", "test", "[", "printf", "date",
  // Type-check / test / lint / format runners
  "tsc", "tsgo", "vitest", "jest", "eslint", "prettier", "pytest", "rspec",
  // Build drivers (task lists these as safe)
  "make", "mvn", "gradle",
  // Language runtimes — a script/module run is caged under confinement.
  // (env is NOT here: it is a WRAPPER stripped by resolveRealArgv0, so
  // `env npm test` resolves through to npm.)
  "node", "deno", "ruby", "python",
]);

// ── Subcommand-gated bins ──
// git: read-only / inspection subcommands only. Deliberately EXCLUDES the
// mutating side (push / pull / fetch / commit / merge / rebase / checkout /
// reset / clean / stash / tag -d / worktree). The destructive floor already
// catches force-push / reset --hard / clean -f / branch -D / filter-branch;
// this set additionally keeps ordinary `git push` (non-force) out of tier-0.
const GIT_SAFE_SUBCOMMANDS = new Set<string>([
  "status", "log", "diff", "show", "branch", "rev-parse", "ls-files",
  "describe", "blame",
]);
// Mutating `git branch` flags/forms that must NOT be tier-0 even though the
// `branch` subcommand is otherwise a read. `-D`/`--delete` is destructive
// (already floored); `-d`/`-m`/`-M`/`--move`/`--copy`/`-c`/`-C`/`--force` and a
// positional branch-name (creation) are not read-only, so they prompt.
const GIT_BRANCH_MUTATING_FLAGS = new Set<string>([
  "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "--force",
]);

// Package-manager subcommands that are pure read/build/test — NEVER install.
// `install`/`i`/`add`/`create`/`exec`/`dlx`/`ci`/`update`/`remove`/`up`/… are
// all absent: installs ALWAYS prompt (standing user rule), even in a sandbox.
const PM_BINS = new Set<string>(["npm", "pnpm", "yarn"]);
const PM_SAFE_SUBCOMMANDS = new Set<string>([
  "run", "test", "build", "typecheck", "lint", "check",
]);

// bun is BOTH a runtime (`bun script.ts`) and a package manager (`bun add`).
// Treat it as a safe runtime EXCEPT when the subcommand is a package-management
// verb — a denylist here (rather than the PM allowlist) so `bun test` /
// `bun script.ts` stay tier-0 while `bun add left-pad` / `bun install` prompt.
// (`bunx` is a SEPARATE argv[0] — not in any safe set — so it always prompts.)
const BUN_PM_VERBS = new Set<string>([
  "add", "install", "i", "remove", "rm", "uninstall", "update", "upgrade",
  "x", "create", "link", "unlink", "pm", "patch", "publish",
]);

const CARGO_SAFE_SUBCOMMANDS = new Set<string>([
  "build", "test", "check", "run", "clippy", "fmt",
]);
const GO_SAFE_SUBCOMMANDS = new Set<string>(["build", "test", "vet"]);

// Device sinks that are fine as an absolute target (a redirect to /dev/null
// must not read as "escaping the user's home").
const BENIGN_ABS_PATHS = new Set<string>([
  "/dev/null", "/dev/stdout", "/dev/stderr", "/dev/zero", "/dev/tty",
]);

// ── Env-var injection guard ──
// resolveRealArgv0 strips a `VAR=val` assignment (both the `env VAR=val cmd`
// wrapper form and a leading inline `VAR=val cmd`) to reach a SAFE_BIN argv[0] —
// but some env vars turn the "safe" command into arbitrary code: LD_PRELOAD /
// DYLD_INSERT_LIBRARIES load an attacker library INTO `ls`; BASH_ENV/ENV source
// an attacker file; PATH-prepend shadows the safe bin; NODE_OPTIONS=--require /
// PYTHONSTARTUP / PERL5OPT / RUBYOPT inject code into the runtime; GIT_SSH* /
// GIT_EXTERNAL_DIFF / GIT_PAGER run an arbitrary program from a "read" git
// command. Any assignment whose NAME is in this set forces a prompt. Benign
// assignments (NODE_ENV=production, DEBUG=1, CI=true, FOO=bar) stay tier-0.
const DANGEROUS_ENV_NAMES = new Set<string>([
  "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "IFS", "PATH", "GLOBIGNORE",
  "NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "PERL5OPT", "PERL5LIB",
  "RUBYOPT", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER",
]);
// A `NAME=value` assignment token: NAME is a clean shell identifier, then `=`.
// `--flag=x` (leading `-`) and `a.b=x` (a `.` breaks the identifier) do NOT match.
const ENV_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

// The pager env vars are VALUE-gated, not name-gated: `GIT_PAGER=cat` is the
// ubiquitous safe idiom (the harness itself sets GIT_PAGER=cat on every spawn,
// src/tools/shell-env.ts) while `GIT_PAGER='sh -c "curl evil"'` is RCE. So a
// pager assignment is dangerous ONLY when its value is outside this tiny
// allowlist. (Every OTHER DANGEROUS_ENV name stays name-only — their risk is the
// value being anything at all, so no value allowlist applies to them.)
const PAGER_ENV_NAMES = new Set<string>(["GIT_PAGER", "PAGER"]);
const SAFE_PAGER_VALUES = new Set<string>([
  "cat", "less", "more", "/bin/cat", "/usr/bin/cat", "",
]);

function isDangerousEnvName(name: string): boolean {
  return DANGEROUS_ENV_NAMES.has(name) || /^LD_/.test(name) || /^DYLD_/.test(name);
}

/** Does ANY token in the segment carry a DANGEROUS_ENV assignment — via the
 *  `env VAR=val cmd` wrapper OR a leading inline `VAR=val cmd`? Scans every
 *  token (a superset covering both forms). LD_ and DYLD_ match by prefix.
 *  GIT_PAGER/PAGER are value-gated against SAFE_PAGER_VALUES. */
function hasDangerousEnvAssignment(tokens: string[]): boolean {
  for (const t of tokens) {
    const m = t.match(ENV_ASSIGN_RE);
    if (!m) continue;
    const name = m[1];
    if (PAGER_ENV_NAMES.has(name)) {
      // Value = everything after `NAME=` (tokenizeCommand already stripped the
      // quotes, so `GIT_PAGER='sh -c "…"'` arrives as one token with the whole
      // command as its value → not in the allowlist → dangerous).
      if (!SAFE_PAGER_VALUES.has(t.slice(m[0].length))) return true;
      continue; // a safe pager value is not dangerous
    }
    if (isDangerousEnvName(name)) return true;
  }
  return false;
}

/** Strip LEADING inline `VAR=val` assignments so resolveRealArgv0 reaches the
 *  real command word. `NODE_ENV=production npm test` → ["npm","test"]. (The
 *  `env`-wrapper form is already handled inside resolveRealArgv0.) */
function stripLeadingInlineAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i])) i++;
  return tokens.slice(i);
}

/** Does ANY token look like an always-blocked sensitive path (cred dir / key /
 *  .env / credentials)? Peels a leading redirect operator and `--flag=` prefix
 *  and surrounding quotes so `>~/.ssh/x` / `--out=~/.aws/credentials` are seen.
 *  Reuses the canonical matchesSensitivePath — mode-independent by design. */
function hasSensitivePathToken(tokens: string[]): boolean {
  for (const raw of tokens) {
    let t = raw.replace(/^['"]+|['"]+$/g, "");
    const redir = t.match(/^\d*(?:>>|>|<)(.*)$/);
    if (redir) t = redir[1];
    if (t.startsWith("-")) {
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      t = t.slice(eq + 1);
    }
    t = t.replace(/^['"]+|['"]+$/g, "");
    if (!t) continue;
    if (matchesSensitivePath(t)) return true;
  }
  return false;
}

/** SAFE_BIN commands that are read-only EXCEPT under a write flag — `sed -i`
 *  (in-place edit) and `sort -o`/`--output` (write to file) mutate a file, so
 *  they must not auto-allow. Kept tight: only the confirmed write modes. */
function safeBinWritesInPlace(argv0: string, args: string[]): boolean {
  if (argv0 === "sed") {
    for (const a of args) {
      if (a === "--in-place" || a.startsWith("--in-place=")) return true;
      // short-flag cluster containing `i` (`-i`, `-i.bak`, `-ni`) → in-place.
      if (a.startsWith("-") && !a.startsWith("--") && a.slice(1).includes("i")) return true;
    }
  }
  if (argv0 === "sort") {
    for (const a of args) {
      if (a === "-o" || a === "--output" || a.startsWith("-o") || a.startsWith("--output=")) return true;
    }
  }
  return false;
}

/** Resolve a segment's argv[0] (canonical) AND the tokens that follow it, so a
 *  subcommand-gated bin can inspect its subcommand. Reuses resolveRealArgv0 for
 *  the command word, then locates that word's token to slice the remainder. */
function argv0AndArgs(tokens: string[]): { argv0: string | null; args: string[] } {
  const argv0 = resolveRealArgv0(tokens);
  if (!argv0) return { argv0: null, args: [] };
  const idx = tokens.findIndex((t) => execBasename(t) === argv0);
  return { argv0, args: idx >= 0 ? tokens.slice(idx + 1) : [] };
}

/** The first non-flag token — the "subcommand" of a multiplexer like git/npm.
 *  Conservative: a value-taking flag's value (`git -c a=b status`) is treated as
 *  the subcommand and, not matching any safe set, falls through to a prompt. */
function firstSubcommand(args: string[]): string | null {
  for (const a of args) {
    if (!a.startsWith("-")) return a.toLowerCase();
  }
  return null;
}

/** Does a privilege-escalation wrapper (sudo/doas) sit in COMMAND position?
 *  Walks past leading shell keywords (then/do/…) only — so `grep sudo x` (sudo
 *  as an ARGUMENT) is not flagged, but `sudo ls` / `then sudo rm` are. */
function hasLeadingEscalation(tokens: string[]): boolean {
  for (const t of tokens) {
    const b = execBasename(t);
    if (SHELL_KEYWORD_PREFIXES.has(b)) continue;
    return b === "sudo" || b === "doas";
  }
  return false;
}

/** Expand a leading ~ the way bash will, so `~/x` is seen as under home. */
function expandHome(t: string): string {
  if (t === "~") return homedir();
  if (t.startsWith("~/") || t.startsWith("~\\")) return join(homedir(), t.slice(2));
  return t;
}

/** Is there an OUT-OF-SCOPE absolute path operand — an absolute path that is
 *  NOT under the user's home dir and not a benign device sink? The executable
 *  token itself (basename === argv0, e.g. `/usr/bin/python3`) is skipped so a
 *  system-binary path doesn't read as an escape. Conservative proxy for
 *  "workspace/user dirs": home is the allowed root. Relative `..` climbs are
 *  NOT flagged here — tier-0 already requires a confined sandbox whose kernel
 *  cage confines the filesystem, and the file-access boundary already vetoed
 *  out-of-workspace climbs upstream in non-unrestricted modes. */
function hasOutOfScopeAbsPath(tokens: string[], argv0: string): boolean {
  const home = homedir();
  for (const raw of tokens) {
    if (execBasename(raw) === argv0) continue; // the binary itself
    let t = raw.replace(/^['"]+|['"]+$/g, ""); // strip surrounding quotes
    // Peel a leading redirect operator (`>f`, `2>>f`, `<f`).
    const redir = t.match(/^\d*(?:>>|>|<)(.*)$/);
    if (redir) t = redir[1];
    // `--flag=/path` / `-o=/path` → keep the value side; a bare flag has no path.
    if (t.startsWith("-")) {
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      t = t.slice(eq + 1);
    }
    t = t.replace(/^['"]+|['"]+$/g, "");
    if (!t) continue;
    t = expandHome(t);
    if (!isAbsolute(t)) continue;
    if (BENIGN_ABS_PATHS.has(t.toLowerCase())) continue;
    // Under the user's home → in scope. Anything else absolute → out of scope.
    const norm = t.replace(/\/+$/, "");
    if (norm === home || norm.startsWith(home + "/")) continue;
    return true;
  }
  return false;
}

/** Does a python invocation shell out to pip (`python -m pip …`)? Such an
 *  install must prompt even though `python` is a safe runtime. */
function pythonInvokesPip(args: string[]): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-m" && execBasename(args[i + 1]) === "pip") return true;
  }
  return false;
}

/** Is a SINGLE shell segment tier-0-safe? */
function isSafeSegment(segment: string): boolean {
  const tokens = tokenizeCommand(segment.trim());
  if (tokens.length === 0) return true; // empty (e.g. trailing `&`) — no command
  if (hasLeadingEscalation(tokens)) return false;
  // HOLE 1 — env loader/hook-var injection: a dangerous VAR=val (env-wrapper or
  // inline) turns a SAFE_BIN into arbitrary code. Scanned before argv0 resolution.
  if (hasDangerousEnvAssignment(tokens)) return false;
  // HOLE 2 — a sensitive-path read/write auto-allowing (home is "in scope", and
  // unrestricted mode makes the upstream path guard a no-op). Mode-independent.
  if (hasSensitivePathToken(tokens)) return false;

  // Strip LEADING inline `VAR=val` (benign like NODE_ENV=production) so the real
  // command word resolves — otherwise `NODE_ENV=production npm test` would read
  // as argv0="node_env=production" and wrongly prompt.
  const rest = stripLeadingInlineAssignments(tokens);
  const { argv0, args } = argv0AndArgs(rest);
  if (!argv0) return false; // only keywords/wrappers, or unresolvable → prompt
  if (hasOutOfScopeAbsPath(rest, argv0)) return false;

  if (SAFE_BINS.has(argv0)) {
    if (argv0 === "python" && pythonInvokesPip(args)) return false;
    // HOLE 3 — a read-only SAFE_BIN used in a WRITE mode (sed -i / sort -o).
    if (safeBinWritesInPlace(argv0, args)) return false;
    return true;
  }

  const sub = firstSubcommand(args);
  if (argv0 === "git") {
    if (sub === null || !GIT_SAFE_SUBCOMMANDS.has(sub)) return false;
    if (sub === "branch") return isSafeGitBranch(args);
    return true;
  }
  if (PM_BINS.has(argv0)) return sub !== null && PM_SAFE_SUBCOMMANDS.has(sub);
  if (argv0 === "bun") {
    // Runtime by default; a package-management verb prompts.
    return sub === null ? true : !BUN_PM_VERBS.has(sub);
  }
  if (argv0 === "cargo") return sub !== null && CARGO_SAFE_SUBCOMMANDS.has(sub);
  if (argv0 === "go") return sub !== null && GO_SAFE_SUBCOMMANDS.has(sub);

  return false; // unknown argv[0] → prompt
}

/** `git branch` is tier-0 only when it is a pure LIST/read — no mutating flag
 *  and no positional branch-name (which would create a branch). */
function isSafeGitBranch(args: string[]): boolean {
  let seenBranch = false;
  for (const a of args) {
    const lower = a.toLowerCase();
    if (!seenBranch) {
      if (lower === "branch") seenBranch = true;
      continue;
    }
    if (a.startsWith("-")) {
      if (GIT_BRANCH_MUTATING_FLAGS.has(lower)) return false;
      continue; // a read flag (--list/-a/-r/-v/--show-current/…)
    }
    return false; // a positional after `branch` → branch creation
  }
  return true;
}

/**
 * Classify a shell command's approval tier.
 *   0 — auto-allow (no prompt): confined sandbox, in scope, EVERY segment's
 *       argv[0] is safe.
 *   1 — prompt (fall through to the existing approval logic): installs, sudo,
 *       network, unknown/unresolvable argv[0], out-of-scope path, host-fallback
 *       sandbox, or any non-safe segment.
 *   2 — destructive floor (unchanged): rm -rf / dd / force-push / … keep their
 *       destructiveOperationReason + irreversible-floor treatment.
 *
 * NEVER downgrades a destructive command to tier-0: the destructive check runs
 * first and returns 2.
 */
export function classifyShellTier(command: string, ctx: ShellTierContext): ShellTier {
  if (typeof command !== "string" || command.trim() === "") return 1;
  // Destructive floor first — a destructive command is never tier-0.
  if (isDestructiveCommand("bash", { command }) !== null) return 2;
  // Without effective OS-level confinement, argv[0] safety is not enough.
  if (!ctx.sandboxConfined) return 1;
  if (ctx.inWorkspaceScope === false) return 1;

  const segments = splitShellSegments(command);
  for (const seg of segments) {
    if (!isSafeSegment(seg)) return 1;
  }
  return 0;
}

/** Shell-spawner tool names whose string `command` is tier-classifiable. */
const SHELL_TIER_TOOLS = new Set<string>(["bash", "shell", "ari_shell"]);
export function isShellTierTool(toolName: string): boolean {
  return SHELL_TIER_TOOLS.has(toolName.toLowerCase());
}
