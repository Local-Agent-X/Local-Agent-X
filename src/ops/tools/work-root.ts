/**
 * The build lane's `work_root`: the ONE directory a delegated build worker
 * may mutate. Resolved exactly as the file-access gate resolves a submitted
 * path (resolveAgentPath — workspace-anchored, or the submitter's own work
 * root for an IDE / project session), then held to the rule that a worker
 * may only mutate where its parent could:
 *
 *   - inside the agent workspace, or inside the submitting session's own
 *     registered work root — nothing else;
 *   - an existing directory (a worker confined to a path that is not there
 *     fails every write);
 *   - not under an enforced plan mode: the parent may not write, so neither
 *     may a worker it spawns (pre-dispatch keys plan mode on the CALLING
 *     session, and the worker's calls run under its own).
 *
 * Omitted, the root is the parent's own scope — its registered work root,
 * else the workspace. Naming a folder narrows the worker; leaving it out
 * never widens it past the submitter, and never refuses the submission.
 *
 * Confinement itself is not decided here: the root is registered on the
 * worker's SecurityLayer and the work-root registry (ops/tools/shared.ts),
 * and the existing delegated gate does the rest.
 */
import { statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { workspaceRoot } from "../../config.js";
import { isEnforcedPlanMode } from "../../canonical-loop/public/plan-ledger.js";
import { realpathDeep, resolveAgentPath, sessionWorkRootOf } from "../../workspace/paths.js";
import type { OpLane } from "../types.js";

/** A submission the caller must correct; the submit tools render the message
 *  as the tool result instead of a harness failure. */
export class WorkRootRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkRootRefused";
  }
}

function isUnder(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve and vet a submitted `work_root` for `lane`. Returns the canonical
 * directory for a build submission, undefined for the read-only lanes (a
 * work_root given there is ignored: those belts cannot mutate). Throws
 * WorkRootRefused with the reason the model must fix.
 */
export function resolveSubmittedWorkRoot(
  raw: unknown,
  lane: OpLane,
  parentSessionId: string | undefined,
): string | undefined {
  if (lane !== "build") return undefined;
  if (parentSessionId && isEnforcedPlanMode(parentSessionId)) {
    throw new WorkRootRefused(
      "plan mode is on for this session: a build worker would write where you may not. Exit plan mode first, or submit on lane 'interactive'.",
    );
  }
  const parentRoot = sessionWorkRootOf(parentSessionId);
  const spelled = typeof raw === "string" ? raw.trim() : "";
  if (!spelled) return parentRoot ?? realpathDeep(workspaceRoot());
  const root = realpathDeep(resolveAgentPath(spelled, parentSessionId));
  let isDirectory = false;
  try { isDirectory = statSync(root).isDirectory(); } catch { /* missing → refused below */ }
  if (!isDirectory) {
    throw new WorkRootRefused(`work_root ${spelled} is not an existing directory. Create it first, or name one that exists.`);
  }
  const allowed = [realpathDeep(workspaceRoot()), ...(parentRoot ? [parentRoot] : [])];
  if (!allowed.some((container) => isUnder(container, root))) {
    throw new WorkRootRefused(
      `work_root ${spelled} is outside the workspace${parentRoot ? " and outside this session's work root" : ""}; a worker may only mutate where you could. Name a directory inside the workspace.`,
    );
  }
  return root;
}
