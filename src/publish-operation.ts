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
 * the command will actually publish from.
 *
 * Cheap by construction: a call that is not a shell spawner costs one Set
 * lookup; a shell call costs one lex of its command line. Nothing here touches
 * the filesystem or spawns a process.
 */
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { commandPositions } from "./security/layer/shell-command-positions.js";
import { mapMsysDrivePath } from "./workspace/paths.js";
import { workspaceRoot } from "./config.js";
import { matchPublishArgv, normalizeBin, unwrapPackageRunner, type PublishKind } from "./publish-operation-table.js";

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
  /** gh pr merge: the PR it names; gh release create: the tag. */
  explicitTarget?: string;
}

/** Tools that spawn a shell on `args.command` (or the structured
 *  `{executable, args}` form). Same set as isDestructiveCommand's spawners. */
const SHELL_SPAWNERS: ReadonlySet<string> = new Set(["bash", "shell", "ari_shell", "process_start", "process_restart"]);

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
  const command = shellCommandText(args);
  if (!command) return [];
  return shellPublishes(tool, command, baseCwd(args));
}

function shellCommandText(args: Record<string, unknown>): string {
  if (typeof args.command === "string") return args.command;
  if (typeof args.executable === "string") {
    const parts = Array.isArray(args.args) ? args.args.map((a) => quoteIfNeeded(String(a))) : [];
    return [quoteIfNeeded(args.executable), ...parts].join(" ");
  }
  return "";
}

function quoteIfNeeded(word: string): string {
  return /[\s;&|]/.test(word) ? `"${word.replace(/"/g, "")}"` : word;
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

function shellPublishes(tool: string, command: string, start: string): PublishOperation[] {
  const found: PublishOperation[] = [];
  // cwd per nesting depth: a nested shell body starts in its parent's
  // directory, and a `cd` inside it does not leak back out.
  const cwdAt: Array<{ dir: string; uncertain: boolean }> = [{ dir: start, uncertain: false }];
  let lastDepth = 0;
  for (const pos of commandPositions(command).positions) {
    if (pos.depth > lastDepth) cwdAt[pos.depth] = { ...cwdAt[pos.depth - 1] };
    cwdAt.length = pos.depth + 1;
    lastDepth = pos.depth;
    const here = cwdAt[pos.depth];
    const bin = normalizeBin(pos.bin);
    if (CD_BINS.has(bin)) {
      const target = cdTarget(pos.words, pos.at);
      const next = target === undefined ? null : resolveDir(here.dir, target);
      cwdAt[pos.depth] = next ? { dir: next, uncertain: here.uncertain } : { dir: here.dir, uncertain: true };
      continue;
    }
    const at = unwrapPackageRunner(pos.words, pos.at);
    const match = matchPublishArgv(pos.words, at);
    if (!match) continue;
    const dir = match.dirArg === undefined ? here.dir : resolveDir(here.dir, match.dirArg);
    found.push({
      kind: match.kind,
      label: match.label,
      tool,
      command,
      cwd: dir ?? here.dir,
      ...(here.uncertain || dir === null ? { cwdUncertain: true } : {}),
      ...(match.pushArgs ? { pushArgs: match.pushArgs } : {}),
      ...(match.explicitTarget ? { explicitTarget: match.explicitTarget } : {}),
    });
  }
  return found;
}
