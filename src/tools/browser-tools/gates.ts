/**
 * Browser tool gate pipeline — everything that decides whether an action may
 * run, and whether its result may leave.
 *
 * Order is load-bearing and is the caller's contract (index.ts):
 *   1. runPreDispatchGates  — download-release approval OR sensitive-page decision
 *   2. humanVerificationBlock — challenge on screen blocks advancing actions
 *   3. dispatch
 *   4. applyProgressGuard   — no-page-change stall stop
 * Nothing here reorders those steps; index.ts calls them in sequence.
 */

import type { ServerEvent, ToolResult } from "../../types.js";
import type { BrowserBackend } from "../../browser/index.js";
import { err } from "./shared.js";
import { recordProgress, resetProgress } from "../../browser/progress-tracker.js";
import { sensitivePageActionDecision } from "../../browser/guards.js";
import { getApprovalManager } from "../../approval-manager.js";
import { blocked, declined } from "../result-helpers.js";
import { HUMAN_VERIFICATION_MESSAGE, requiresHumanVerification } from "../../browser/human-verification.js";
import { RESET_ACTIONS, TRACKED_ACTIONS, READ_ONLY_ACTIONS, HUMAN_VERIFICATION_BLOCKED_ACTIONS } from "./action-tables.js";

/**
 * Outcome of the pre-dispatch gates. `halt` is a terminal ToolResult the tool
 * returns as-is; `proceed` carries the ask-level secret-read grant URL (or
 * null) that scopes the dispatch tail's read grant.
 */
export type PreDispatchOutcome =
  | { kind: "halt"; result: ToolResult }
  | { kind: "proceed"; grantedReadUrl: string | null };

/**
 * The pre-dispatch approval gates. `args` is mutated in place on the
 * release_download path (`_downloadApproval`), exactly as before.
 */
export async function runPreDispatchGates(
  action: string,
  args: Record<string, unknown>,
  manager: BrowserBackend,
  sessionId: string,
  onEvent: ((e: { type: string; [k: string]: unknown }) => void) | undefined,
): Promise<PreDispatchOutcome> {
  const halt = (result: ToolResult): PreDispatchOutcome => ({ kind: "halt", result });
  // Set when an ask-level secret-read approval unlocked this page's
  // stub; the dispatch tail then runs inside runWithSensitiveReadGrant
  // so the unlock is visible to exactly this call's async chain
  // (handlers, backends, post-dispatch backstop) and to no one else.
  let grantedReadUrl: string | null = null;
  if (action === "release_download") {
    const id = String(args.download_id || "");
    if (!id) return halt(err("'download_id' is required. Use action='downloads' first."));
    if (!onEvent) return halt(blocked(
      "BLOCKED: quarantined downloads can only be released from an interactive session with explicit user approval.",
      { layer: "browser-download", browserStatus: "approval-required" },
    ));
    let approvalBinding: ReturnType<BrowserBackend["getDownloadApproval"]>;
    try { approvalBinding = manager.getDownloadApproval(id); }
    catch (error) { return halt(blocked(`BLOCKED: ${(error as Error).message}`, { layer: "browser-download", browserStatus: "not-releasable" })); }
    const outcome = await getApprovalManager().requestApprovalDetailed({
      toolName: "browser.release_download",
      toolCallId: String(args._toolCallId || `browser-release-${id}`),
      sessionId,
      context: "Release a quarantined browser download into workspace/downloads. The file remains unavailable to agent tools until approved.",
      args: { action: "release_download", ...approvalBinding },
      alwaysAsk: true,
      emit: onEvent as (event: ServerEvent) => void,
    });
    if (!outcome.approved) return halt(declined(
      "Download release was not approved; the file remains quarantined.",
      { layer: "browser-download", browserStatus: "quarantined", downloadId: id },
    ));
    args._downloadApproval = approvalBinding;
  } else {
    const pageUrl = manager.getCurrentUrl();
    const pageDecision = sensitivePageActionDecision(pageUrl, action);
    if (pageDecision.disposition === "blocked") return halt(blocked(
      `BLOCKED: ${pageDecision.reason}`,
      { layer: "browser-sensitive-page", browserStatus: "blocked", category: pageDecision.category },
    ));
    if (pageDecision.disposition === "approval-required") {
      if (!onEvent) return halt(blocked(
        `BLOCKED: ${pageDecision.reason} Explicit approval is unavailable in this run.`,
        { layer: "browser-sensitive-page", browserStatus: "approval-required", category: pageDecision.category },
      ));
      const outcome = await getApprovalManager().requestApprovalDetailed({
        toolName: "browser.sensitive_page_action",
        toolCallId: String(args._toolCallId || `browser-sensitive-${sessionId}`),
        sessionId,
        context: `${pageDecision.reason} Approve only if you expect this action. Page contents and form values are intentionally omitted.`,
        args: { action, category: pageDecision.category, page: pageDecision.page },
        alwaysAsk: true,
        emit: onEvent as (event: ServerEvent) => void,
      });
      if (!outcome.approved) return halt(declined(
        `Sensitive-page ${action} was not approved; no browser action was performed.`,
        { layer: "browser-sensitive-page", browserStatus: "declined", category: pageDecision.category },
      ));
      // Ask-level secret READ approved: the dispatch tail below runs
      // inside the read-grant async context for exactly this page
      // URL, covering the post-dispatch stub backstop too — approved
      // content is not clobbered on the way out.
      if (pageDecision.unlocksRead) grantedReadUrl = pageUrl;
    }
  }
  return { kind: "proceed", grantedReadUrl };
}

/**
 * Blocks advancing actions while a human-verification challenge is on screen.
 * Returns the block result, or null when dispatch may proceed.
 */
export async function humanVerificationBlock(
  action: string,
  manager: BrowserBackend,
): Promise<ToolResult | null> {
  if (HUMAN_VERIFICATION_BLOCKED_ACTIONS.has(action)) {
    const observation = await manager.observe();
    if (requiresHumanVerification(observation)) {
      return blocked(HUMAN_VERIFICATION_MESSAGE, {
        layer: "browser-human-verification",
        browserStatus: "human-verification-required",
      });
    }
  }
  return null;
}

/**
 * After an advancing action, fingerprint the page and trip a no-progress stop
 * if the session has spun without moving the page. The isError result feeds the
 * circuit breaker (run-sandboxed records isError as a failure), so an agent that
 * ignores the warning and keeps hammering gets a hard cooldown.
 */
export async function applyProgressGuard(
  action: string,
  manager: BrowserBackend,
  sessionId: string,
  result: ToolResult,
): Promise<ToolResult> {
  // Co-drive preemption: the human took the wheel, so the action never ran —
  // an unchanged page here is NOT the agent spinning. Reset instead of
  // recording, so a preempted stretch can't false-trip the breaker.
  if (result.metadata?.userActive === true) {
    resetProgress(sessionId);
    return result;
  }
  if (RESET_ACTIONS.has(action)) {
    resetProgress(sessionId);
    return result;
  }
  if (!TRACKED_ACTIONS.has(action) || result.isError) return result;
  // Defense in depth: a read-only action never represents "trying to move the
  // page", so its result — often the agent's own re-perceive recovery move —
  // must never be replaced by the stall error. TRACKED_ACTIONS already excludes
  // reads; this makes the invariant explicit and regression-proof.
  if (READ_ONLY_ACTIONS.has(action)) return result;
  // Cap the fingerprint read: a hung page-eval here must not ride the outer
  // tool timeout and report a completed action as a timeout. Timing out yields
  // "" — recordProgress treats that as "unknown" (neither progress nor stall).
  let fpTimer: ReturnType<typeof setTimeout> | undefined;
  const fingerprint = await Promise.race([
    manager.fingerprint(),
    new Promise<string>((resolve) => { fpTimer = setTimeout(() => resolve(""), 2000); }),
  ]);
  clearTimeout(fpTimer);
  const { stalled, unchanged } = recordProgress(sessionId, fingerprint);
  if (!stalled) return result;
  return err(
    `No page change after ${unchanged} consecutive browser actions — the page is not responding to what you're doing. ` +
    `Stop repeating the same action. Try a different approach: a different ref/selector, scroll to reveal off-screen ` +
    `elements, navigate elsewhere, or stop and ask the user. Repeating will open the circuit breaker.`,
  );
}
