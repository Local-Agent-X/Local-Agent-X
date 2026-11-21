/**
 * The holdout seal: no model tool call may read, list, search or change a
 * build's held-out scenarios (`<data dir>/holdout/`, holdout/paths.ts).
 *
 * The scenarios are the test a build is scored against. A builder that can read
 * them builds to the test instead of to the spec, and a passing score then means
 * nothing. Before this the suite sat in the project's `scenarios/` and the
 * builder was asked not to look (auto-build/agents/chunk-runner.ts); nothing
 * stopped it, and the folder was even served under /apps/.
 *
 * No agent is exempt, the judge included: a role name can be written by the
 * model (agent_create), so an exemption keyed on one is a door. Only harness
 * code reads the suite, through fs, never through a tool. Writing it goes
 * through holdout_write, which reaches the store without a path argument.
 *
 * It holds in every file-access mode, unrestricted included. The shell half
 * reads the command line, so a path it cannot see (`$(…)`, a variable that does
 * not spell the folder) gets past it; where the sandbox confines the shell, the
 * cage denies the data dir as a whole (sandbox/validate.ts), which this does not
 * replace.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { SecurityDecision } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import { holdoutRoot } from "../../holdout/paths.js";
import { pathIsWithin } from "./path-within.js";
import { realpathDeep, resolveAgentPathFrom } from "../../workspace/paths.js";
import { positionsWithCwd } from "./shell-delete-targets.js";
import { declaredPaths, pathSpecsForCall, shellCommandOf } from "../../tool-registry.js";
import { cwdOf } from "../../tool-execution/internal-args.js";

/** The folder spelled in any form a command line may carry it: `~/.lax/holdout`, `$HOME/.lax\holdout`, `/c/Users/x/.lax/holdout`. */
const SPELLED = /\.lax[\\/]+holdout(?:[\\/'"\s]|$)/i;
/** Commands that read a whole folder tree when named one (or the folder they run in). */
const TREE_READERS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "tree", "du", "get-childitem", "gci", "select-string",
]);
/** Commands that copy or pack folder trees: every operand but the last (the destination) is read. */
const TREE_COPIERS = new Set(["cp", "rsync", "scp", "tar", "zip", "7z", "robocopy", "xcopy", "copy-item"]);

/** `subject` names what reached the suite: "`cat x`", "a search from C:\Users\x". */
function refuse(subject: string): SecurityDecision {
  return {
    allowed: false,
    reason: `Blocked: ${subject} reaches the sealed test suite (${holdoutRoot()}). No agent reads the scenarios a build ` +
      "is scored against; the build's judge scores them. Build from spec/ instead.",
    userHint: USER_HINTS.fileSystem,
  };
}

const forms = (p: string): string[] => [resolve(p), realpathDeep(resolve(p))];
/** The path is the sealed folder or inside it. */
const inSeal = (p: string): boolean => forms(p).some((f) => pathIsWithin(holdoutRoot(), f));
/** The path is a folder the sealed one sits under: a tree read from it reaches the suite. */
const aboveSeal = (p: string): boolean => forms(p).some((f) => pathIsWithin(f, holdoutRoot()));

function expandTilde(word: string): string {
  return word === "~" || /^~[\\/]/.test(word) ? homedir() + word.slice(1) : word;
}

/** An operand as a path from `cwd`; null when it is relative and the folder is unknown. */
function placed(word: string, cwd: string | null | undefined): string | null {
  const w = expandTilde(word.includes("=") && word.startsWith("-") ? word.slice(word.indexOf("=") + 1) : word);
  if (isAbsolute(w)) return w;
  return cwd ? resolve(cwd, w) : null;
}

/** A shell command line run from `base`. */
export function holdoutShellRefusal(command: string, base: string): SecurityDecision | null {
  if (SPELLED.test(command) || command.toLowerCase().includes(holdoutRoot().toLowerCase())) return refuse("this command");
  for (const { position: p, cwd } of positionsWithCwd(command, base)) {
    if (cwd && inSeal(cwd)) return refuse(`\`${p.words.slice(p.at).join(" ")}\`, run from ${cwd},`);
    const operands = p.words.slice(p.at + 1).filter((w) => w && !(w.startsWith("-") && !w.includes("=")));
    const targets = [...operands, ...p.redirections.map((r) => r.target).filter((t) => t && !/^\d+$/.test(t))];
    const walked = TREE_COPIERS.has(p.bin) ? new Set(operands.slice(0, -1)) : TREE_READERS.has(p.bin) ? new Set(operands) : new Set<string>();
    for (const word of targets) {
      const path = placed(word, cwd);
      // From a folder this cannot place (a cd to `~` or an expansion), a relative
      // name that starts with the suite's own folder name is taken to be it.
      if (path === null ? /^holdout(?:[\\/]|$)/i.test(word) : inSeal(path)) return refuse(`\`${word}\``);
      if (path && walked.has(word) && aboveSeal(path)) return refuse(`\`${p.bin}\` over ${word}`);
    }
    // `rg foo` walks the folder it runs in: its only operand is the pattern.
    const namesFolder = operands.some((w) => { const path = placed(w, cwd); return path !== null && existsSync(path); });
    if (TREE_READERS.has(p.bin) && !namesFolder && cwd && aboveSeal(cwd)) {
      return refuse(`\`${p.bin}\` over ${cwd}`);
    }
  }
  return null;
}

/**
 * The seal over one tool call, keyed on its policy row: every declared path
 * argument (read or write; a search root that holds the suite), and for a
 * shell-command tool its command and the folder it runs in.
 */
export function holdoutCallRefusal(
  toolName: string,
  args: Record<string, unknown>,
  workspace: string,
  sessionId: string | undefined,
): SecurityDecision | null {
  for (const spec of pathSpecsForCall(toolName, args)) {
    for (const raw of declaredPaths(args, spec) ?? []) {
      const p = resolveAgentPathFrom(workspace, raw, sessionId);
      if (inSeal(p)) return refuse(raw);
      if (spec.searchRoot && aboveSeal(p)) return refuse(`a search from ${raw}`);
    }
  }
  const command = shellCommandOf(toolName, args);
  if (command === undefined) return null;
  const named = typeof args.cwd === "string" && args.cwd ? resolveAgentPathFrom(workspace, args.cwd, sessionId) : undefined;
  if (named && inSeal(named)) return refuse(`a process started in ${args.cwd}`);
  return holdoutShellRefusal(command, named ?? cwdOf(args) ?? workspace);
}
