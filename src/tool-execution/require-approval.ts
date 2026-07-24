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
import {
  cleanTurnForModelSelfSave,
  describeMemoryPromotionRequest,
  describePromotionForHuman,
  isFactDbPromotion,
  stampApprovedMemoryPromotion,
  stampCleanModelPromotion,
  stampTaintedModelPromotion,
  stampTrustedUserPromotion,
  taintedPromotionQuotaExhausted,
  trustedCurrentUserEvidence,
} from "../memory/promotion-gate.js";
import { hasExternalIngestion } from "../data-lineage/external.js";
import { classifyShellTier, isShellTierTool } from "./shell-approval-tier.js";
import { getSandboxStatus } from "../sandbox/index.js";

export const requireApprovalPhase: Phase = async (ctx) => {
  const promotion = describeMemoryPromotionRequest(
    ctx.tc.name,
    ctx.args,
    ctx.sessionId || "default",
  );
  // Session-level external-ingestion taint (data-lineage/external.ts)
  // downgrades "trusted current-user evidence" to risky: once this session
  // has seen off-box content (web/browser/MCP/email), a user-looking span may
  // itself be laundered injection, so the silent stamp-and-continue path is
  // off — the promotion falls through to interactive approval (and therefore
  // hard-blocks in unattended runs, same as any risky promotion).
  const sessionClean = !hasExternalIngestion(ctx.sessionId || "default");
  const trustedEvidence = promotion && sessionClean
    ? trustedCurrentUserEvidence(promotion, ctx.priorMessages as unknown[] | undefined)
    : null;
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

  // Tier-0 shell fast-path — the biggest autonomy win. A genuinely-safe shell
  // command (effectively-confined sandbox, in scope, EVERY chain segment's
  // resolved argv[0] in the read-only/build/test SAFE_BIN set) auto-allows with
  // NO prompt, even on a profile whose shell tier is "ask" (Safe). This bypasses
  // ONLY the interactive profile prompt: the SecurityLayer denylist / egress /
  // network-argv0 / rm-floor / file-access boundary already ran in
  // enforcePolicyPhase's runPreDispatch BEFORE this phase, so a blocked command
  // never arrives here — tier-0 cannot resurrect a denied command. Placed AFTER
  // the profile hard-deny above (a profile that DENIES shell still wins) and
  // guarded so it never overrides a destructive op, a policy-required approval,
  // or a memory promotion. Interactive-only (callContext==="local"): unattended
  // runs stay governed by the profile + unattended-shell-gate, unchanged.
  //
  // The kernel is NOT a second prompt here: its `approve-shell` policy resolves
  // through onApprovalRequired (lifecycle.ts) which returns true unconditionally,
  // so the kernel never prompts/blocks shell — this require-approval phase is the
  // sole shell-prompt gate, and a tier-0 CONTINUE here yields ZERO prompts
  // end-to-end. (The tier classifier lives in src/ and cannot be imported by the
  // separate arikernel package without a dependency cycle / a forked SAFE_BIN
  // list, so the tier is enforced HERE, where the classifier + sandbox signal +
  // profile all live.)
  if (
    ctx.callContext === "local" &&
    !destructive &&
    !ctx.policyApprovalReason &&
    !promotion &&
    isShellTierTool(ctx.tc.name) &&
    typeof ctx.args.command === "string" &&
    classifyShellTier(ctx.args.command, { sandboxConfined: getSandboxStatus().confined }) === 0
  ) {
    return CONTINUE;
  }

  if (promotion && trustedEvidence) {
    stampTrustedUserPromotion(ctx.args, promotion, trustedEvidence);
    return CONTINUE;
  }

  // Clean-session model self-save: on a session that never ingested external
  // (untrusted off-box) content — and whose current turn carries no
  // external-untrusted marker anywhere, tool results included — the model may
  // promote its own reasoning without a human click, there being nothing
  // laundered to guard against. Memory prompts therefore only appear once a
  // session has touched off-box content (web/browser/MCP/email); that
  // session-level taint OR a turn-level untrusted marker falls the promotion
  // through to interactive approval, same as any risky one.
  if (promotion && sessionClean && cleanTurnForModelSelfSave(ctx.priorMessages as unknown[] | undefined)) {
    stampCleanModelPromotion(ctx.args, promotion);
    return CONTINUE;
  }

  // Tainted (or taint-marked-turn) FACT-DB promotion: proceeds without a
  // human click — in chat and unattended runs alike — stamped with the
  // `:tainted-external` provenance the sink persists and recall renders as
  // untrusted (fact-provenance-label.ts). No approval is needed because no
  // trust is being promoted: the saved fact stays exactly as untrusted as
  // the external content it may paraphrase. Non-fact targets (profile files,
  // project briefs, daily log) cannot carry per-item provenance, so they
  // fall through to interactive approval as before.
  if (promotion && isFactDbPromotion(promotion)) {
    const quotaSession = ctx.sessionId || "default";
    if (taintedPromotionQuotaExhausted(quotaSession)) {
      const result: ToolResult = {
        content:
          `BLOCKED: ${ctx.tc.name} hit this session's tainted-memory write quota. ` +
          `This session has read external content and already saved the maximum number of unreviewed facts. ` +
          `Stop saving; existing facts are unaffected.`,
        isError: true,
        status: "blocked",
        metadata: { layer: "approval", userHint: USER_HINTS.policy },
      };
      return terminate(ctx, { rendered: "model", result, allowed: false });
    }
    stampTaintedModelPromotion(ctx.args, promotion);
    return CONTINUE;
  }

  const policyRequiresPrompt = !!ctx.policyApprovalReason || !!promotion;
  if (!policyRequiresPrompt && !decisionRequiresPrompt(decision)) return CONTINUE;

  // Unattended run: no human to prompt. The profile says "ask" and nothing
  // authorized it, so block rather than silently run (this is the
  // load-bearing guarantee for cron/delegated runs).
  if (ctx.callContext !== "local") {
    const result: ToolResult = {
      content:
        `BLOCKED (unattended): ${ctx.tc.name} needs human approval` +
        `${promotion ? " because risky content cannot become durable memory without explicit user approval" : ctx.policyApprovalReason ? ` because ${ctx.policyApprovalReason}` : " under the active autonomy profile"}, ` +
        `but no one is watching this ${ctx.callContext} run. ` +
        `Run this under the Autonomous profile (or pin a per-job profile) to allow it.`,
      isError: true,
      status: "blocked",
      metadata: { layer: "approval", userHint: USER_HINTS.policy },
    };
    return terminate(ctx, { rendered: "model", result, allowed: false });
  }
  if (!ctx.onEvent) {
    if (!promotion) return CONTINUE;
    const result: ToolResult = {
      content: `BLOCKED: ${ctx.tc.name} cannot promote model-originated content without an interactive approval channel.`,
      isError: true,
      status: "blocked",
      metadata: { layer: "approval", userHint: USER_HINTS.policy },
    };
    return terminate(ctx, { rendered: "model", result, allowed: false });
  }

  const outcome = await getApprovalManager().requestApprovalDetailed({
    toolName: ctx.tc.name,
    toolCallId: ctx.tc.id,
    sessionId: ctx.sessionId || "default",
    context: promotion
      ? describePromotionForHuman(promotion)
      : destructive
      ? `⚠ Irreversible operation (${destructive}) — confirm before running. ${ctx.approvalContext}`
      : ctx.policyApprovalReason
        ? `Policy approval required: ${ctx.policyApprovalReason}. ${ctx.approvalContext}`
        : ctx.approvalContext,
    args: promotion ? { ...promotion } : ctx.args,
    alwaysAsk: !!destructive || policyRequiresPrompt,
    // Canonical op id (chat-tool-dispatcher threads opts.opId through
    // executeToolCalls as `operationId`): keys the durable pendingApproval
    // column + canonical events. Absent on non-op dispatches.
    opId: ctx.operationId,
    emit: ctx.onEvent,
  });
  if (outcome.approved) {
    if (promotion) {
      if (!outcome.grantId) throw new Error("approved memory promotion missing canonical grant id");
      stampApprovedMemoryPromotion(ctx.args, promotion, outcome.grantId);
    }
    return CONTINUE;
  }

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
