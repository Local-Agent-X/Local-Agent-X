// Approval phase: profile-gated user consent for tool calls. Branches on the
// four-valued Decision from the active autonomy profile. In an unattended run
// (cron/delegated) there is no human to prompt, so the profile IS the
// authorization contract: "ask" tiers block, and only "allow" /
// "allow-with-rollback" proceed. Run such a job under Autonomous (or pin a
// per-job profile) to grant the tiers it needs.

import { USER_HINTS, type ToolResult } from "../types.js";
import {
  type ApprovalDenyReason,
  getApprovalManager,
  getToolDecision,
  getRiskDecision,
  decisionRequiresPrompt,
  decisionDenies,
  applyIrreversibleFloor,
  destructiveOperationReason,
} from "../approval-manager.js";
import type { Phase } from "./context.js";
import { terminate, CONTINUE } from "./context.js";

export const requireApprovalPhase: Phase = async (ctx) => {
  // An irreversible operation is RECLASSIFIED to the profile's destructive
  // tier and re-decided there — so `bash rm -rf` is decided by the
  // destructive rule (not the coarse shell grant), while a profile that
  // explicitly allows destructive (Power/Autonomous — "autonomous for
  // everything except money and secrets") runs it without a prompt. The
  // profile table is the single source of truth; there is no confirm floor
  // above it.
  const destructive = destructiveOperationReason(ctx.tc.name, ctx.args);
  let decision = destructive
    ? getRiskDecision("destructive", ctx.sessionId)
    : getToolDecision(ctx.tc.name, ctx.sessionId);

  // Irreversible-action floor: in an interactive run, force one confirm before a
  // truly-unrecoverable shell op (rm -rf, dd, force-push, …) even if the profile
  // would allow it silently. Unattended runs stay governed by the profile.
  if (ctx.callContext === "local") {
    decision = applyIrreversibleFloor(decision, ctx.tc.name, ctx.args);
  }

  if (decisionDenies(decision)) {
    const result: ToolResult = {
      content: `BLOCKED by profile: ${ctx.tc.name} (risk class denied)`,
      isError: true,
      status: "blocked",
      metadata: { layer: "approval", userHint: USER_HINTS.policy },
    };
    return terminate(ctx, { rendered: "model", result, allowed: false });
  }

  const policyRequiresPrompt = !!ctx.policyApprovalReason;
  if (!policyRequiresPrompt && !decisionRequiresPrompt(decision)) return CONTINUE;

  // Unattended run: no human to prompt. The profile says "ask" and nothing
  // authorized it, so block rather than silently run (this is the
  // load-bearing guarantee for cron/delegated runs).
  if (ctx.callContext !== "local") {
    const result: ToolResult = {
      content:
        `BLOCKED (unattended): ${ctx.tc.name} needs human approval` +
        `${ctx.policyApprovalReason ? ` because ${ctx.policyApprovalReason}` : " under the active autonomy profile"}, ` +
        `but no one is watching this ${ctx.callContext} run. ` +
        `Run this under the Autonomous profile (or pin a per-job profile) to allow it.`,
      isError: true,
      status: "blocked",
      metadata: { layer: "approval", userHint: USER_HINTS.policy },
    };
    return terminate(ctx, { rendered: "model", result, allowed: false });
  }
  if (!ctx.onEvent) return CONTINUE;

  const outcome = await getApprovalManager().requestApprovalDetailed({
    toolName: ctx.tc.name,
    toolCallId: ctx.tc.id,
    sessionId: ctx.sessionId || "default",
    context: destructive
      ? `⚠ Irreversible operation (${destructive}) — confirm before running. ${ctx.approvalContext}`
      : ctx.policyApprovalReason
        ? `Policy approval required: ${ctx.policyApprovalReason}. ${ctx.approvalContext}`
        : ctx.approvalContext,
    args: ctx.args,
    alwaysAsk: !!destructive || policyRequiresPrompt,
    emit: ctx.onEvent,
  });
  if (outcome.approved) return CONTINUE;

  // The denial reason decides the status — only an actual human "no" is
  // `declined`. A timed-out or torn-down card was never answered, and a card
  // superseded by a chat reply means "read the message"; both stay `blocked`
  // (absent/deferred human ≠ human said no). Profile-deny and unattended
  // branches above are also `blocked`. Exhaustive on purpose: an unknown or
  // missing reason must NEVER fabricate "declined by user" — the default is
  // a neutral blocked result (no producer emits undefined today; this guards
  // the next resolution path someone adds).
  const result: ToolResult = buildDenialResult(ctx.tc.name, outcome.reason);
  return terminate(ctx, { rendered: "model", result, allowed: false });
};

function buildDenialResult(toolName: string, reason: ApprovalDenyReason | undefined): ToolResult {
  switch (reason) {
    case "declined":
      // A human said no to THIS call — `declined`, not `blocked`. The tool
      // works and policy doesn't forbid it forever.
      return {
        content: `DECLINED by user: ${toolName}. Do not immediately retry the same call — adjust your approach or ask the user. If the user then tells you to proceed, you may request approval again.`,
        isError: true,
        status: "declined",
        metadata: { layer: "approval", userHint: USER_HINTS.declined },
      };
    case "timeout":
      return {
        content: `Approval request timed out for ${toolName} — nobody answered. Do not assume consent; proceed with other work or ask the user.`,
        isError: true,
        status: "blocked",
        metadata: { layer: "approval", userHint: USER_HINTS.approvalTimeout },
      };
    case "superseded":
      return {
        content: `Approval request for ${toolName} was dismissed because the user replied in chat instead of clicking. Re-read their latest message; if they said to proceed, you may request approval again.`,
        isError: true,
        status: "blocked",
        metadata: { layer: "approval", userHint: USER_HINTS.approvalSuperseded },
      };
    default:
      return {
        content: `Approval for ${toolName} was not granted — no explicit user decision was recorded. Do not assume consent; adjust your approach or ask the user.`,
        isError: true,
        status: "blocked",
        metadata: { layer: "approval", userHint: USER_HINTS.approvalTimeout },
      };
  }
}
