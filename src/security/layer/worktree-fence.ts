/**
 * The worktree fence: a spawned agent working in a git worktree may read the
 * repository the worktree was cut from, but may not change it. Its changes
 * belong on its own branch, in its own worktree, and merge back when it ends.
 *
 * Before this the worktree only anchored relative paths: an absolute path, a
 * `cd <repo> && git commit`, a `git -C <repo>`, or a process started in the
 * repo wrote straight into the user's checkout, and the promise in the agent's
 * prompt ("You work in an isolated git worktree") was kept by obedience alone
 * (audit 2026-10-25). The owner's ruling (2026-11-02): such a write is refused,
 * naming the worktree, not put to the user — the write always has a right
 * place, and in an unattended run a card would only park.
 *
 * The shell half is an allow-list, not a write detector: inside the fenced
 * repository only commands that cannot change a file run (ls, grep, git log,
 * …). Anything else there — a build, a script, `git commit` — is refused,
 * because which programs write is not knowable from the command line.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { SecurityDecision } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import { pathIsWithin } from "./path-within.js";
import { realpathDeep, resolveAgentPathFrom } from "../../workspace/paths.js";
import { placeCd, positionsWithCwd } from "./shell-delete-targets.js";
import type { CommandPosition } from "./shell-command-positions.js";
import { declaredPaths, pathSpecsForCall, shellCommandOf } from "../../tool-registry.js";
import { cwdOf } from "../../tool-execution/internal-args.js";

export interface WorktreeFence {
  /** The agent's worktree: everything under it is the agent's to change. */
  worktree: string;
  /** The checkout it was cut from (`git rev-parse --show-toplevel`). */
  repoRoot: string;
}

/** Inside the fenced repository and outside the agent's own worktree, by the
 *  path as written or as it resolves on disk (a symlink into the repo). */
function inFence(fence: WorktreeFence, path: string): boolean {
  return [resolve(path), realpathDeep(resolve(path))].some(
    (p) => pathIsWithin(fence.repoRoot, p) && !pathIsWithin(fence.worktree, p),
  );
}

/** The same place in the worktree: where the agent meant to write. */
function inWorktree(fence: WorktreeFence, path: string): string {
  return resolve(fence.worktree, relative(resolve(fence.repoRoot), resolve(path)));
}

const ruling = (fence: WorktreeFence) =>
  `It is inside ${fence.repoRoot}, the repository your worktree was cut from. Read it freely, but change files only in ` +
  `your worktree, ${fence.worktree}: your branch merges back into ${fence.repoRoot} when you finish.`;

function refuse(reason: string): SecurityDecision {
  return { allowed: false, reason: `Blocked: ${reason}`, userHint: USER_HINTS.fileSystem };
}

/** A file tool writing, editing or deleting `absPath`. */
export function fenceWriteRefusal(fence: WorktreeFence, absPath: string): SecurityDecision | null {
  if (!inFence(fence, absPath)) return null;
  return refuse(`${absPath} would be changed. ${ruling(fence)} Write ${inWorktree(fence, absPath)} instead.`);
}

/** A process started (or restarted) with `cwd` as its folder: whatever it runs
 *  there can write there. */
export function fenceProcessCwdRefusal(fence: WorktreeFence, cwd: string): SecurityDecision | null {
  if (!inFence(fence, cwd)) return null;
  return refuse(`the process would run in ${cwd}. ${ruling(fence)} Start it in ${inWorktree(fence, cwd)}.`);
}

// ── Commands that cannot change a file (absent a write redirection) ──
const READ_ONLY_BINS = new Set([
  "ls", "dir", "cat", "head", "tail", "less", "more", "wc", "grep", "egrep", "fgrep", "rg", "ag", "stat", "file",
  "md5sum", "sha1sum", "sha256sum", "sha512sum", "test", "[", "echo", "printf", "pwd", "which", "whereis", "realpath",
  "readlink", "dirname", "basename", "diff", "cmp", "tree", "du", "df", "true", "false", "date", "whoami", "id",
  "uname", "cut", "tr", "jq", "nl", "od", "hexdump", "strings", "column",
]);
const FIND_ACTIONS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const GIT_READ_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "grep", "cat-file",
  "shortlog", "rev-list", "merge-base", "for-each-ref", "show-ref", "help", "version",
]);
// Global options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

/** The git subcommand and its arguments, past global options. */
function gitCommand(args: string[]): { sub: string; rest: string[] } {
  for (let i = 0; i < args.length; i++) {
    if (GIT_VALUE_OPTIONS.has(args[i])) { i++; continue; }
    if (args[i].startsWith("-")) continue;
    return { sub: args[i], rest: args.slice(i + 1) };
  }
  return { sub: "", rest: [] };
}

function gitReadOnly(args: string[]): boolean {
  const { sub, rest } = gitCommand(args);
  if (GIT_READ_SUBCOMMANDS.has(sub)) return true;
  const positional = rest.filter((w) => !w.startsWith("-"));
  if (sub === "branch" || sub === "tag") return positional.length === 0 && rest.every((w) => /^(?:-[alrv]+|--list|--all|--remotes|--verbose|--contains|--merged|--no-merged|--sort=.*|--format=.*)$/.test(w));
  if (sub === "remote") return positional.length === 0 || (positional.length === 2 && positional[0] === "get-url");
  if (sub === "config") return rest.some((w) => /^(?:--get|--get-all|--get-regexp|--list|-l)$/.test(w));
  if (sub === "stash" || sub === "worktree") return positional[0] === "list" || (sub === "stash" && positional[0] === "show");
  return false;
}

function readOnly(p: CommandPosition): boolean {
  const args = p.words.slice(p.at + 1);
  if (p.bin === "git") return gitReadOnly(args);
  if (p.bin === "find") return !args.some((w) => FIND_ACTIONS.has(w));
  if (p.bin === "sort") return !args.some((w) => w === "-o" || w.startsWith("--output"));
  return READ_ONLY_BINS.has(p.bin);
}

/** The folder a `git -C <dir>` points the command at, or the position's own. */
function gitDir(p: CommandPosition, cwd: string | null | undefined): string | null | undefined {
  if (p.bin !== "git") return cwd;
  let dir = cwd;
  const args = p.words.slice(p.at + 1);
  for (let i = 0; i < args.length; i++) {
    // git -C takes any relative path as relative: no CDPATH there.
    if (args[i] === "-C") dir = dir === null ? null : placeCd(args[++i], dir, true) ?? null;
    else if (!args[i].startsWith("-")) break;
  }
  return dir;
}

const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);
const DEVICE = /^\/dev\//;
// Copies and links write only their last operand (or -t's value).
const DESTINATION_ONLY_BINS = new Set(["cp", "rsync", "scp", "install", "ln"]);

/** The absolute paths a command names that it may write: every absolute operand
 *  (or `--opt=/abs`), but only the destination of a copy or link. */
function absoluteOperands(p: CommandPosition): string[] {
  const args = p.words.slice(p.at + 1);
  const paths = args.map((w) => (w.includes("=") ? w.slice(w.indexOf("=") + 1) : w)).filter((w) => isAbsolute(w) && !DEVICE.test(w));
  if (!DESTINATION_ONLY_BINS.has(p.bin)) return paths;
  const t = args.indexOf("-t");
  if (t >= 0 && args[t + 1]) return isAbsolute(args[t + 1]) ? [args[t + 1]] : [];
  const last = args.filter((w) => !w.startsWith("-")).pop();
  return last && isAbsolute(last) ? [last] : [];
}

/**
 * A shell command line (bash's, process_start's) run from `base`. Refused when a
 * command that can write runs inside the fenced repository (after a `cd`, or
 * at a `git -C`), names a path there it may write, or redirects output into it
 * — and when a `cd` this cannot place is followed by a command that can write,
 * since that command could be anywhere.
 */
export function fenceShellRefusal(fence: WorktreeFence, command: string, base: string): SecurityDecision | null {
  // A top-level cd to a folder that exists lands, so its folder carries past
  // `;` too: `cd sub; npm test` runs in sub (the delete proofs' same hook).
  const cdLands = (dir: string) => existsSync(dir) && statSync(dir).isDirectory();
  // Without CDPATH a bare `cd sub` is `cd ./sub`: place it, unless CDPATH is
  // in the server's environment (the shell inherits it) or the command sets it.
  const bareNamesRelative = !process.env.CDPATH && !/\bCDPATH\b/.test(command);
  for (const { position: p, cwd } of positionsWithCwd(command, base, cdLands, bareNamesRelative)) {
    const dir = gitDir(p, cwd);
    const writes = !readOnly(p);
    const name = p.words.slice(p.at).join(" ");
    if (dir === null && writes) {
      return refuse(`\`${name}\` runs in a folder this check cannot place (a cd to an expansion, \`~\` or a bare name). ` +
        `Your worktree is ${fence.worktree}: cd there by its full path first.`);
    }
    if (dir && writes && inFence(fence, dir)) {
      return refuse(`\`${name}\` would run in ${dir} and may change it. ${ruling(fence)} Run it in ${inWorktree(fence, dir)} ` +
        `(cd there, or git -C ${fence.worktree}).`);
    }
    const targets = p.redirections
      .filter((r) => WRITE_REDIRECTS.has(r.op) && r.target && !/^\d+$/.test(r.target) && !DEVICE.test(r.target))
      .map((r) => (isAbsolute(r.target) ? r.target : dir ? resolve(dir, r.target) : null));
    const named = writes ? absoluteOperands(p) : [];
    for (const target of [...targets, ...named]) {
      if (target === null) {
        return refuse(`\`${name}\` writes a relative path from a folder this check cannot place. ` +
          `Your worktree is ${fence.worktree}: cd there by its full path first.`);
      }
      if (inFence(fence, target)) {
        return refuse(`\`${name}\` would write ${target}. ${ruling(fence)} Write ${inWorktree(fence, target)} instead.`);
      }
    }
  }
  return null;
}

/**
 * The fence over one tool call, keyed on the call's declared facts (its
 * policy row), never its name: every path argument that writes, and for a
 * shell-command tool its command and the folder it runs in — `cwd` when the
 * call names one (process_start/_restart), else the stamped `_cwd` bash runs
 * in, else the workspace, where a process with no folder starts.
 */
export function fenceCallRefusal(
  fence: WorktreeFence,
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
  sessionId: string,
): SecurityDecision | null {
  for (const spec of pathSpecsForCall(toolName, args)) {
    if (spec.action === "read") continue;
    for (const p of declaredPaths(args, spec) ?? []) {
      const refused = fenceWriteRefusal(fence, resolveAgentPathFrom(workspace, p, sessionId));
      if (refused) return refused;
    }
  }
  const command = shellCommandOf(toolName, args);
  if (command === undefined) return null;
  const named = typeof args.cwd === "string" && args.cwd ? resolveAgentPathFrom(workspace, args.cwd, sessionId) : undefined;
  if (named) {
    const refused = fenceProcessCwdRefusal(fence, named);
    if (refused) return refused;
  }
  const base = named ?? cwdOf(args) ?? workspace;
  return fenceShellRefusal(fence, command, base);
}
