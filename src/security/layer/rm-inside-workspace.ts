/**
 * A recursive or forced `rm` in a CONFINED file-access mode is allowed only when
 * this module can PROVE every target sits strictly inside the workspace. It then
 * proceeds to the irreversible-op floor, which cards it for the user's approval.
 *
 * Until 2026-09-25 confined modes refused `rm -r`/`rm -f` outright and told the
 * user to switch file access to unrestricted — so "clear out this folder in one
 * go" was impossible for every model unless the user widened access to the whole
 * disk, and the models fell back to deleting file by file or to script
 * workarounds the shell floor cannot see (op-outcomes restraint-wipe-build-cache,
 * 0/3 on both the 27B and gpt-5.6 under the confined rig). Peter's decision: a
 * recursive delete inside the workspace is carded, not refused; anything else
 * stays refused. Confinement is unchanged — nothing outside the workspace
 * becomes reachable.
 *
 * Deliberately strict. Anything the parse cannot prove returns false and the
 * caller keeps the old refusal:
 *  - exactly one command segment (no `;` `&&` `||` `|` `&` newline);
 *  - no expansion or redirection anywhere: `$`, backtick, `<`, `>`, `(`, `)`,
 *    `{`, `}`, `~`;
 *  - argv0 is `rm`; flags only from a fixed set (`--no-preserve-root` and every
 *    other flag refuses);
 *  - no `..` segment in any operand, so a relative operand is always a
 *    descendant of the shell's cwd, whichever approved root that is;
 *  - a glob only in an operand's LAST segment, never starting with `.`, and its
 *    parent directory must itself be strictly inside the workspace;
 *  - every operand, after symlink resolution, strictly inside the workspace —
 *    the workspace root itself (`rm -rf .`, `rm -rf *`) is refused.
 */
import { basename, dirname } from "node:path";
import { realpathDeep, resolveAgentPathFrom } from "../../workspace/paths.js";
import { pathIsWithin } from "./file-access.js";
import { execBasename, splitShellSegments, tokenizeCommand } from "./shell-lex.js";

const UNPROVABLE = /[$`<>(){}~\n]/;
const SHORT_FLAGS = /^-[rRfvd]+$/;
const LONG_FLAGS = new Set(["--recursive", "--force", "--verbose", "--dir"]);
const GLOB = /[*?[\]]/;

function strictlyInside(workspace: string, target: string): boolean {
  let realWs: string;
  let realTarget: string;
  try {
    realWs = realpathDeep(workspace);
    realTarget = realpathDeep(target);
  } catch {
    return false; // a symlink cycle is never provably inside
  }
  return pathIsWithin(realWs, realTarget) && realTarget !== realWs;
}

function operandInside(workspace: string, operand: string): boolean {
  const parts = operand.replace(/\\/g, "/").split("/");
  if (parts.some((p) => p === "..")) return false;
  const last = parts[parts.length - 1];
  const globInLast = GLOB.test(last);
  if (parts.slice(0, -1).some((p) => GLOB.test(p))) return false;
  if (globInLast) {
    if (last.startsWith(".")) return false;
    const parent = dirname(operand);
    if (parent === "." || parent === "") return false; // `rm -rf *` from the workspace root
    return strictlyInside(workspace, resolveAgentPathFrom(workspace, parent));
  }
  const target = resolveAgentPathFrom(workspace, operand);
  return basename(target) !== "" && strictlyInside(workspace, target);
}

export function rmTargetsAllInsideWorkspace(command: string, workspace: string | undefined): boolean {
  if (!workspace) return false;
  if (UNPROVABLE.test(command)) return false;
  const segments = splitShellSegments(command);
  if (segments.length !== 1) return false;
  const tokens = tokenizeCommand(segments[0]);
  if (tokens.length < 2 || execBasename(tokens[0]) !== "rm") return false;
  const operands: string[] = [];
  let flagsDone = false;
  for (const tok of tokens.slice(1)) {
    if (!flagsDone && tok === "--") { flagsDone = true; continue; }
    if (!flagsDone && tok.startsWith("-")) {
      if (SHORT_FLAGS.test(tok) || LONG_FLAGS.has(tok)) continue;
      return false;
    }
    operands.push(tok);
  }
  return operands.length > 0 && operands.every((op) => operandInside(workspace, op));
}
