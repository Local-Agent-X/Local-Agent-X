// The delegated-agent worktree-isolation gate — extracted from layer-core.ts's
// evaluate() to keep that class under the source-hygiene LOC ceiling. Pure
// policy: given the delegated call and three predicates over the SecurityLayer's
// state, it returns a blocking SecurityDecision or null (pass through to the
// shared command/file vetting). Behavior is identical to the inlined form.

import type { SecurityDecision } from "../../types.js";
import { USER_HINTS } from "../../types.js";
import type { ToolCallContext } from "./types.js";
import { hasCapability } from "../../tool-registry.js";

export interface DelegatedGateDeps {
  hasSessionWorktree(sessionId: string | undefined): boolean;
  /** OS-containment half of the gate (confined sandbox / acknowledged host /
   *  scoped work root) — see SecurityLayer.delegatedShellOsContained. */
  delegatedShellOsContained(sessionId: string | undefined): boolean;
  isUserContentPath(targetPath: string): boolean;
}

/**
 * Delegated agents using write/edit/bash must have worktree isolation IF they're
 * modifying repo SOURCE code. Writes to user-content territory (workspace/,
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
 * The caller invokes this only when callContext === "delegated" and the tool is
 * in WORKTREE_REQUIRED_TOOLS. Returns a blocking decision, or null to continue.
 */
export function evaluateDelegatedWorktreeGate(
  ctx: ToolCallContext,
  deps: DelegatedGateDeps,
): SecurityDecision | null {
  const { toolName, args } = ctx;
  const sessionKey = ctx.sessionId;
  const hasWorktree = deps.hasSessionWorktree(sessionKey);

  if (hasCapability(toolName, "shell")) {
    // ── Delegated-shell containment gate (chunk K) ──
    // A delegated agent MAY run shell to self-verify its own work (build /
    // type-check / test — the aider-polyglot / workflow-subagent case that was
    // blocked for 7 weeks) ONLY when it is DOUBLY contained:
    //   (1) worktree isolation      — its writes can't reach the main agent's
    //                                  live running source, AND
    //   (2) effective OS containment — a confined sandbox (or an acknowledged
    //                                  host / scoped work root; see
    //                                  delegatedShellOsContained), so the shell's
    //                                  children/redirects/expansions are caged,
    //                                  not just its top-level argv.
    // Missing EITHER → block (err safe). cron never reaches here: shell is in
    // CONTEXT_RESTRICTED_TOOLS for cron and was denied above. The command
    // denylist / rm / egress / network-client rules run downstream regardless
    // (evaluateShellCommandAndPaths), so a dangerous command (rm -rf, curl, …)
    // stays blocked even when the agent is fully contained.
    if (!hasWorktree) {
      return {
        allowed: false,
        reason: `Blocked: delegated shell tool "${toolName}" requires worktree isolation to run (no worktree is provisioned for this session)`,
        userHint: USER_HINTS.worktreeIsolation,
      };
    }
    if (!deps.delegatedShellOsContained(sessionKey)) {
      return {
        allowed: false,
        reason: `Blocked: delegated shell tool "${toolName}" requires an effectively-confined sandbox — the selected sandbox fell back to the unconfined host and this run has no operator acknowledgement or scoped work root, so a self-verify shell cannot be contained`,
        userHint: USER_HINTS.policy,
      };
    }
    // Contained (worktree + OS containment) → fall through.
    return null;
  }

  if (!hasWorktree) {
    // Non-shell workspace-write tools (write/edit/ari_file/delete_file):
    // isolation is required only for repo SOURCE paths — user-content writes are
    // exempt (they don't touch the agent's running code).
    //
    // ari_file is a single bridge tool whose action (read|write) lives in
    // args.action — a read never mutates source, and a write to user-content
    // territory is exempt just like write/edit. So gate only ari_file WRITES to
    // source paths, mirroring the write/edit reasoning above.
    const ariFileAction = toolName === "ari_file" ? String(args.action || "read") : null;
    const ariFileExempt = ariFileAction === "read" ||
      (ariFileAction === "write" && deps.isUserContentPath(String(args.path || "")));
    // delete_file shares edit's `path` arg + blast radius → a user-content delete
    // skips the worktree too (else all delegated deletes were refused).
    const isContentWrite =
      ((toolName === "write" || toolName === "edit" || toolName === "delete_file") &&
        deps.isUserContentPath(String(args.path || ""))) ||
      ariFileExempt;
    if (!isContentWrite) {
      return {
        allowed: false,
        reason: `Blocked: delegated agent "${toolName}" requires worktree isolation for source-code paths (writes to workspace/, ~/Documents, or anywhere outside the repo don't need it)`,
        userHint: USER_HINTS.worktreeIsolation,
      };
    }
  }
  return null;
}
