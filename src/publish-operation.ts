/**
 * publishOperation — is this tool call about to SHIP something? A git push, a
 * deploy, a package publish, a release. Sibling of destructiveOperationReason
 * (approval-decision.ts): that one asks "can this be undone?", this one asks
 * "will other people get what this call sends?". A hit sends the call through
 * the publish review gate (tool-execution/publish-review-gate.ts) before any
 * approval decision is made.
 *
 * Shell recognition walks every command position (security/layer/
 * shell-command-positions.ts — nested shell bodies included, the real command
 * word past wrappers) and matches argv, never a substring. Alongside it this
 * tracks the directory each position runs in (`cd x && git push`, `git -C x
 * push`, `vercel --cwd x`), because the review has to look at the repository
 * the command will actually publish from, and the variables the command sets
 * on the way (`export GIT_SSH_COMMAND=…; git push`), because a git push's
 * review has to know what it runs with.
 *
 * Cheap by construction: a call that is not a shell spawner costs one Set
 * lookup; a shell call costs one lex of its command line. Nothing here touches
 * the filesystem or spawns a process.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { commandPositions } from "./security/layer/shell-command-positions.js";
import { execBasename } from "./security/layer/shell-lex.js";
import { mapMsysDrivePath } from "./workspace/paths.js";
import { workspaceRoot } from "./config.js";
import {
  assignedNames, matchPublishArgv, normalizeBin, pastAssignments, unwrapPackageRunner, type GitOption, type PublishKind,
} from "./publish-operation-table.js";

export type { PublishKind } from "./publish-operation-table.js";

export interface PublishOperation {
  kind: PublishKind;
  /** Short human label: `git push origin main`, `vercel --prod`, `npm publish`. */
  label: string;
  /** The tool call that runs it. */
  tool: string;
  /** The full command line (shell tools), for the card. */
  command?: string;
  /** Absolute directory the publishing command runs in. */
  cwd: string;
  /** The directory could not be worked out statically (`cd $DIR`). */
  cwdUncertain?: boolean;
  /** git-push: the arguments after `push`, verbatim. */
  pushArgs?: string[];
  /** git-push: git's own options before `push` (`-c k=v`, `--git-dir d`), in order. */
  gitOptions?: GitOption[];
  /** git-push: names of the variables set for it — assigned in front of git,
   *  set earlier in the command (`export`, `$env:`, cmd's `set`), or passed in
   *  the tool's own `env` argument. */
  gitEnv?: string[];
  /** gh pr merge: the PR it names; gh release create: the tag. */
  explicitTarget?: string;
}

/** Tools that spawn a shell on `args.command`. Same set as
 *  isDestructiveCommand's spawners. */
const SHELL_SPAWNERS: ReadonlySet<string> = new Set(["bash", "shell", "process_start", "process_restart"]);

/**
 * Registered LAX tools whose whole purpose is to publish or deploy, by name.
 * None exists today: deploys run through the shell (the CLIs above) or a
 * connector's HTTP API. publish-operation.test.ts scans the tool registry for
 * deploy/publish/release-shaped names and fails on any that is in neither this
 * table nor NOT_PUBLISH_TOOLS, so the next one is classified on purpose.
 */
export const PUBLISH_TOOLS: Readonly<Record<string, PublishKind>> = {};

/** Registered tools whose NAME looks like publishing but which do not ship
 *  anything, with the reason. */
export const NOT_PUBLISH_TOOLS: Readonly<Record<string, string>> = {
  issue_release: "releases the agent's lock on a task-board issue; nothing leaves the machine",
};

/** The first publish this call would perform, or null. */
export function publishOperation(toolName: string, args: Record<string, unknown>): PublishOperation | null {
  return publishOperations(toolName, args)[0] ?? null;
}

/**
 * Every publish this call would perform, in command order. A compound command
 * (`git push && vercel --prod`) ships twice; the gate reviews both.
 */
export function publishOperations(toolName: string, args: Record<string, unknown>): PublishOperation[] {
  const tool = toolName.toLowerCase();
  const byName = PUBLISH_TOOLS[tool];
  if (byName) return [{ kind: byName, label: tool, tool, cwd: baseCwd(args) }];
  if (!SHELL_SPAWNERS.has(tool)) return [];
  if (typeof args.command !== "string" || !args.command) return [];
  // process_start / process_restart run the command with extra variables.
  const toolEnv = args.env && typeof args.env === "object" && !Array.isArray(args.env) ? Object.keys(args.env) : [];
  return shellPublishes(tool, args.command, baseCwd(args), toolEnv);
}

/** Where the tool starts the command: the stamped worktree/session root
 *  (`_cwd`), an explicit `cwd` argument, else the workspace — the same anchor
 *  shell-tool.ts and process-session.ts use. */
function baseCwd(args: Record<string, unknown>): string {
  if (typeof args._cwd === "string" && args._cwd) return resolve(args._cwd);
  const root = workspaceRoot();
  if (typeof args.cwd === "string" && args.cwd) return resolveDir(root, args.cwd) ?? root;
  return root;
}

/** Resolve a directory word against `from`; null when it depends on runtime
 *  expansion (`$DIR`, `%DIR%`, `$(…)`, `-`). */
function resolveDir(from: string, dir: string): string | null {
  if (!dir || dir === "-" || /[$%`]/.test(dir)) return null;
  const msys = mapMsysDrivePath(dir);
  if (msys) return msys;
  if (dir === "~") return homedir();
  if (dir.startsWith("~/") || dir.startsWith("~\\")) return resolve(homedir(), dir.slice(2));
  return isAbsolute(dir) ? resolve(dir) : resolve(from, dir);
}

// Commands that change the directory for the rest of their shell body.
const CD_BINS = new Set(["cd", "pushd", "chdir", "set-location", "sl"]);
const CD_PATH_FLAGS = new Set(["-path", "-literalpath"]);

function cdTarget(words: string[], at: number): string | undefined {
  for (let i = at + 1; i < words.length; i++) {
    const w = words[i];
    if (CD_PATH_FLAGS.has(w.toLowerCase())) return words[i + 1];
    if (w.startsWith("-") && w !== "-") continue;
    return w;
  }
  return "~";
}

// Statements that set a variable for the rest of their shell body: bash's
// export family, cmd's `set NAME=value`, and PowerShell's `$env:NAME = …`.
// Assignments with no command after them are the fourth form. The export
// family counts every NAME it names, with or without `=value`: the value can
// come from anywhere (`read V <<< x; export V`, `printf -v V x; declare -x V`).
const EXPORT_FAMILY = new Set(["export", "declare", "typeset", "readonly", "local"]);
const NAME_WORD = /^([A-Za-z_][A-Za-z0-9_]*)(?:\+?=|$)/;
const PS_ENV_ASSIGNMENT = /^\$\{?env:([A-Za-z_][A-Za-z0-9_]*)\}?(\+?=)?/i;

/** The names an environment statement sets, or null when `words` is not one.
 *  `cmdAt` is the command word past the leading assignments (pastAssignments). */
function envStatement(words: string[], at: number, cmdAt: number, bin: string): string[] | null {
  if (EXPORT_FAMILY.has(bin)) {
    return [...assignedNames(words.slice(at, cmdAt)), ...words.slice(cmdAt + 1).flatMap((w) => NAME_WORD.exec(w)?.[1] ?? [])];
  }
  if (cmdAt === words.length || bin === "set") return assignedNames(words.slice(at));
  const ps = PS_ENV_ASSIGNMENT.exec(words[cmdAt]);
  return ps && (ps[2] || /^\+?=/.test(words[cmdAt + 1] ?? "")) ? [ps[1]] : null;
}

function shellPublishes(tool: string, command: string, start: string, toolEnv: string[]): PublishOperation[] {
  const found: PublishOperation[] = [];
  // The directory and the variables set so far, per nesting depth: a nested
  // shell body starts with its parent's, and a `cd` or `export` inside it does
  // not leak back out.
  const bodyAt: Array<{ dir: string; uncertain: boolean; env: string[] }> = [{ dir: start, uncertain: false, env: toolEnv }];
  let lastDepth = 0;
  for (const pos of commandPositions(command).positions) {
    if (pos.depth > lastDepth) bodyAt[pos.depth] = { ...bodyAt[pos.depth - 1] };
    bodyAt.length = pos.depth + 1;
    lastDepth = pos.depth;
    const here = bodyAt[pos.depth];
    // The command word past any leading assignments: in `X=a/cd b` it is `b`.
    const cmdAt = pastAssignments(pos.words, pos.at);
    const bin = normalizeBin(execBasename(pos.words[cmdAt] ?? ""));
    const set = envStatement(pos.words, pos.at, cmdAt, bin);
    if (set) {
      bodyAt[pos.depth] = { ...here, env: [...here.env, ...set] };
      continue;
    }
    if (CD_BINS.has(bin)) {
      const target = cdTarget(pos.words, cmdAt);
      const next = target === undefined ? null : resolveDir(here.dir, target);
      bodyAt[pos.depth] = next ? { ...here, dir: next } : { ...here, uncertain: true };
      continue;
    }
    const at = unwrapPackageRunner(pos.words, cmdAt);
    const match = matchPublishArgv(pos.words, at);
    if (!match) continue;
    const dir = match.dirArg === undefined ? here.dir : resolveDir(here.dir, match.dirArg);
    const gitEnv = match.kind === "git-push" ? [...new Set([...here.env, ...(match.gitEnv ?? [])])] : [];
    found.push({
      kind: match.kind,
      label: match.label,
      tool,
      command,
      cwd: dir ?? here.dir,
      ...(here.uncertain || dir === null ? { cwdUncertain: true } : {}),
      ...(match.pushArgs ? { pushArgs: match.pushArgs } : {}),
      ...(match.gitOptions ? { gitOptions: match.gitOptions } : {}),
      ...(gitEnv.length ? { gitEnv } : {}),
      ...(match.explicitTarget ? { explicitTarget: match.explicitTarget } : {}),
    });
  }
  return found;
}
