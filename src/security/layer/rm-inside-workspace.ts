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
 * caller keeps the old refusal. The deletes are read by the one delete
 * extractor (shell-delete-targets.ts), every form (rm, Remove-Item, rd /s, …):
 *  - every destructive delete is one of the plain deletes that open the
 *    command, before anything else runs (`leadingRun`: no wrapper, no body,
 *    nothing piped or backgrounded beside them). What follows them runs after
 *    and is judged by the other rules: `rm -rf node_modules && npm install`,
 *    which the floor's disposable proof clears, was refused here for its
 *    chain until 2026-10-27;
 *  - no expansion or redirection in those deletes: `$`, backtick, `<`, `>`,
 *    `(`, `)`, `{`, `}`, `~`;
 *  - an `rm`'s flags only from a fixed set (`--no-preserve-root` and every
 *    other flag refuses);
 *  - no `..` segment in any operand, so a relative operand is always a
 *    descendant of the shell's cwd, whichever approved root that is;
 *  - a glob only in an operand's LAST segment, never starting with `.`, and its
 *    parent directory must itself be strictly inside the workspace;
 *  - every operand, after symlink resolution, strictly inside the workspace —
 *    the workspace root itself (`rm -rf .`, `rm -rf *`) is refused.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { realpathDeep, resolveAgentPathFrom } from "../../workspace/paths.js";
import { pathIsWithin } from "./file-access.js";
import { leadingRun, plainDelete, shellDeletes, type DeleteCall } from "./shell-delete-targets.js";

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

/** `inside` → hand it to the floor's card. `workspace-prefix` → bash already
 *  runs inside the workspace, so `workspace/x` names a folder that does not
 *  exist and approving it deletes nothing — refused up front with the right
 *  spelling rather than carded as a no-op (op-outcomes EXP-24c: the 27B's
 *  first `rm -r workspace/client-data/build-cache` was carded, approved, and
 *  removed nothing, and a second card followed). `unprovable` → refused. */
export type RmInsideVerdict = "inside" | "workspace-prefix" | "unprovable";

export function rmInsideWorkspaceVerdict(command: string, workspace: string | undefined): RmInsideVerdict {
  if (!workspace) return "unprovable";
  const lead = leadingRun(command, (segment) => plainDelete(segment) !== null) ?? [];
  const deletes = lead.map((segment) => plainDelete(segment)!);
  const destructive = (d: DeleteCall) => d.recursive || d.forced;
  // Every destructive delete the command makes is one of those leading ones.
  if (lead.length === 0 || shellDeletes(command).filter(destructive).length !== deletes.filter(destructive).length) return "unprovable";
  if (lead.some((segment) => UNPROVABLE.test(segment))) return "unprovable";
  if (deletes.some((d) => d.verb === "rm" && !d.flags.every((f) => SHORT_FLAGS.test(f) || LONG_FLAGS.has(f)))) return "unprovable";
  const operands = deletes.flatMap((d) => d.targets);
  if (deletes.some((d) => d.targets.length === 0)) return "unprovable";
  if (!existsSync(join(workspace, "workspace")) && operands.some((op) => /^(\.\/)?workspace[/\\]/.test(op))) return "workspace-prefix";
  return operands.every((op) => operandInside(workspace, op)) ? "inside" : "unprovable";
}

export function rmTargetsAllInsideWorkspace(command: string, workspace: string | undefined): boolean {
  return rmInsideWorkspaceVerdict(command, workspace) === "inside";
}
