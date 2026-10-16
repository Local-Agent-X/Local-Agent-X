// The delegated-agent worktree-isolation gate — extracted from layer-core.ts's
// evaluate() to keep that class under the source-hygiene LOC ceiling. Pure
// policy: given the delegated call and four predicates over the SecurityLayer's
// state and the sandbox status, it returns a blocking SecurityDecision or null
// (pass through to the shared command/file vetting).

import type { SecurityDecision } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import type { ToolCallContext } from "./types.js";
import { declaredPaths, hasCapability, pathSpecsForCall } from "../../tool-registry.js";
import { SANDBOX_PROOF_PENDING_RETRY } from "../../sandbox/index.js";

export interface DelegatedGateDeps {
  hasSessionWorktree(sessionId: string | undefined): boolean;
  /** OS-containment half of the gate (confined sandbox / acknowledged host)
   *  — see SecurityLayer.delegatedShellOsContained. */
  delegatedShellOsContained(): boolean;
  /** The Windows cage is still proving its fence (sandbox status proofPending). */
  sandboxProofPending(): boolean;
  isUserContentPath(targetPath: string): boolean;
}

/**
 * Worker runs (WORKER_CONTEXTS: delegated agents and scheduled jobs) using
 * write/edit/bash must have worktree isolation IF they're modifying repo SOURCE
 * code. Writes to user-content territory (workspace/,
 * ~/Documents, ~/Desktop, anywhere outside the repo) don't need isolation — the
 * sandbox protects the agent's own running code from mid-task mutation, NOT the
 * workers producing user-facing artifacts. The old blanket rule killed every
 * content-creation worker where worktree provisioning wasn't wired up (the
 * polish-the-pptx case).
 *
 * For shell tools the requirement is STRICTER: worktree isolation is not enough —
 * a self-verify shell also needs effective OS containment, because a shell's
 * children / redirects / expansions escape the worktree that write/edit's
 * explicit `path` arg keeps them inside.
 *
 * The caller invokes this only for a WORKER_CONTEXTS call whose tool is in
 * WORKTREE_REQUIRED_TOOLS. Returns a blocking decision, or null to continue.
 */
export function evaluateDelegatedWorktreeGate(
  ctx: ToolCallContext,
  deps: DelegatedGateDeps,
): SecurityDecision | null {
  const { toolName, args } = ctx;
  const sessionKey = ctx.sessionId;
  const hasWorktree = deps.hasSessionWorktree(sessionKey);
  const run = ctx.callContext === "cron" ? "scheduled job" : "delegated agent";

  if (hasCapability(toolName, "shell")) {
    // ── Delegated-shell containment gate (chunk K) ──
    // A delegated agent MAY run shell to self-verify its own work (build /
    // type-check / test — the aider-polyglot / workflow-subagent case that was
    // blocked for 7 weeks) ONLY when it is DOUBLY contained:
    //   (1) worktree isolation      — its writes can't reach the main agent's
    //                                  live running source, AND
    //   (2) effective OS containment — a confined sandbox (or an acknowledged
    //                                  host; see delegatedShellOsContained), so
    //                                  the shell's children/redirects/expansions
    //                                  are caged, not just its top-level argv.
    //                                  A work root anchors the run; it cages
    //                                  nothing.
    // Missing EITHER → block (err safe). A scheduled job is held to the same
    // AND: its missions folder is its work root. The command
    // denylist / rm / egress / network-client rules run downstream regardless
    // (evaluateShellCommandAndPaths), so a dangerous command (rm -rf, curl, …)
    // stays blocked even when the agent is fully contained.
    if (!hasWorktree) {
      return {
        allowed: false,
        reason: `Blocked: a ${run}'s shell tool "${toolName}" requires worktree isolation to run (no worktree is provisioned for this session)`,
        userHint: USER_HINTS.worktreeIsolation,
      };
    }
    if (!deps.delegatedShellOsContained()) {
      // Not an unconfined host yet: the Windows cage is still proving its
      // fence, and its answer lands within seconds.
      if (deps.sandboxProofPending()) {
        return {
          allowed: false,
          reason: `Blocked for now: a ${run}'s shell tool "${toolName}" waits for the sandbox. ${SANDBOX_PROOF_PENDING_RETRY}`,
          userHint: SANDBOX_PROOF_PENDING_RETRY,
        };
      }
      return {
        allowed: false,
        reason: `Blocked: a ${run}'s shell tool "${toolName}" requires an effectively-confined sandbox — the selected sandbox fell back to the unconfined host and the user has not acknowledged unconfined unattended shell in Settings > Security, so the command cannot be contained`,
        userHint: USER_HINTS.policy,
      };
    }
    // Contained (worktree + OS containment) → fall through.
    return null;
  }

  if (!hasWorktree) {
    // A call that writes (the caller passes only those, by the call's own path
    // specs): isolation is required only for repo SOURCE paths — a call whose
    // every write target is user content is exempt (it doesn't touch the
    // agent's running code). Every write arg the call opens is judged, so a
    // synonym (edit_lines, multi_edit), a second target (restore_file's
    // destination) or a document tool's file_path is held to the same rule. A
    // malformed path value fails closed.
    const targets = pathSpecsForCall(toolName, args)
      .filter((spec) => spec.action !== "read")
      .flatMap((spec) => declaredPaths(args, spec) ?? [""]);
    if (!targets.every((target) => deps.isUserContentPath(target))) {
      return {
        allowed: false,
        reason: `Blocked: a ${run}'s "${toolName}" requires worktree isolation for source-code paths (writes to workspace/, ~/Documents, or anywhere outside the repo don't need it)`,
        userHint: USER_HINTS.worktreeIsolation,
      };
    }
  }
  return null;
}
