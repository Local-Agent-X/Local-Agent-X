// Data tables for the shell approval-tier classifier (shell-approval-tier.ts).
// Pure constants + one pure predicate over them — split out to keep the
// classifier logic under the source-hygiene LOC ceiling. No behavior lives here
// beyond the argv[0] catalogs the classifier consults.

// ── SAFE_BIN: read-only + build/test tools whose bare invocation is tier-0 ──
// Plain members: any invocation with this argv[0] is tier-0 (subject to the
// sandbox + scope + escalation gates). Runtimes (node/deno/ruby/python) are
// here because under a confined backend the inline-eval body they may run is
// caged; python carries an extra pip guard in the classifier so
// `python -m pip install` still prompts.
export const SAFE_BINS = new Set<string>([
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
export const GIT_SAFE_SUBCOMMANDS = new Set<string>([
  "status", "log", "diff", "show", "branch", "rev-parse", "ls-files",
  "describe", "blame",
]);
// Mutating `git branch` flags/forms that must NOT be tier-0 even though the
// `branch` subcommand is otherwise a read. `-D`/`--delete` is destructive
// (already floored); `-d`/`-m`/`-M`/`--move`/`--copy`/`-c`/`-C`/`--force` and a
// positional branch-name (creation) are not read-only, so they prompt.
export const GIT_BRANCH_MUTATING_FLAGS = new Set<string>([
  "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "--force",
]);

// Package-manager subcommands that are pure read/build/test — NEVER install.
// `install`/`i`/`add`/`create`/`exec`/`dlx`/`ci`/`update`/`remove`/`up`/… are
// all absent: installs ALWAYS prompt (standing user rule), even in a sandbox.
export const PM_BINS = new Set<string>(["npm", "pnpm", "yarn"]);
export const PM_SAFE_SUBCOMMANDS = new Set<string>([
  "run", "test", "build", "typecheck", "lint", "check",
]);

// bun is BOTH a runtime (`bun script.ts`) and a package manager (`bun add`).
// Treat it as a safe runtime EXCEPT when the subcommand is a package-management
// verb — a denylist here (rather than the PM allowlist) so `bun test` /
// `bun script.ts` stay tier-0 while `bun add left-pad` / `bun install` prompt.
// (`bunx` is a SEPARATE argv[0] — not in any safe set — so it always prompts.)
export const BUN_PM_VERBS = new Set<string>([
  "add", "install", "i", "remove", "rm", "uninstall", "update", "upgrade",
  "x", "create", "link", "unlink", "pm", "patch", "publish",
]);

export const CARGO_SAFE_SUBCOMMANDS = new Set<string>([
  "build", "test", "check", "run", "clippy", "fmt",
]);
export const GO_SAFE_SUBCOMMANDS = new Set<string>(["build", "test", "vet"]);

// Device sinks that are fine as an absolute target (a redirect to /dev/null
// must not read as "escaping the user's home").
export const BENIGN_ABS_PATHS = new Set<string>([
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
export const DANGEROUS_ENV_NAMES = new Set<string>([
  "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "IFS", "PATH", "GLOBIGNORE",
  "NODE_OPTIONS", "PYTHONPATH", "PYTHONSTARTUP", "PERL5OPT", "PERL5LIB",
  "RUBYOPT", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_PAGER",
]);
// A `NAME=value` assignment token: NAME is a clean shell identifier, then `=`.
// `--flag=x` (leading `-`) and `a.b=x` (a `.` breaks the identifier) do NOT match.
export const ENV_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

// The pager env vars are VALUE-gated, not name-gated: `GIT_PAGER=cat` is the
// ubiquitous safe idiom (the harness itself sets GIT_PAGER=cat on every spawn,
// src/tools/shell-env.ts) while `GIT_PAGER='sh -c "curl evil"'` is RCE. So a
// pager assignment is dangerous ONLY when its value is outside this tiny
// allowlist. (Every OTHER DANGEROUS_ENV name stays name-only — their risk is the
// value being anything at all, so no value allowlist applies to them.)
export const PAGER_ENV_NAMES = new Set<string>(["GIT_PAGER", "PAGER"]);
export const SAFE_PAGER_VALUES = new Set<string>([
  "cat", "less", "more", "/bin/cat", "/usr/bin/cat", "",
]);

export function isDangerousEnvName(name: string): boolean {
  return DANGEROUS_ENV_NAMES.has(name) || /^LD_/.test(name) || /^DYLD_/.test(name);
}
