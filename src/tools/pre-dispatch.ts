/**
 * Pre-dispatch gate chain — the checks every tool call must pass before
 * execution, regardless of which dispatcher routed it. Both the chat-path
 * (src/tool-executor.ts) and the AriKernel-path
 * (packages/arikernel/tool-executors/*) call this, closing F3 from DRY-AUDIT.md.
 *
 * Policy evaluation is unified through src/tool-policy/evaluator.ts (F4).
 * Four packs (security, default-policy, threat, arikernel) are evaluated in
 * one pass; session-policy / RBAC / approval remain per-user gates outside
 * the pack mechanism.
 */
import type { SecurityLayer } from "../security/index.js";
import { checkSessionPolicy } from "../session/policy.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat/threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import {
  getApprovalManager,
  getToolDecision,
  decisionRequiresPrompt,
  decisionDenies,
  isDestructiveCommand,
} from "../approval-manager.js";
import { getRuntimeConfig } from "../config.js";
import { isProtectedSetting } from "../settings-schema.js";
import type { ServerEvent } from "../types.js";
import { USER_HINTS } from "../types.js";
import { evaluate as evaluatePolicy, type RulePack } from "../tool-policy/evaluator.js";
import { makeSecurityLayerPack } from "../tool-policy/packs/security-layer-pack.js";
import { makeDefaultPolicyPack } from "../tool-policy/packs/default-policy-pack.js";
import { makeThreatEnginePack } from "../tool-policy/packs/threat-engine-pack.js";
import { makeArikernelPack } from "../tool-policy/packs/arikernel-pack.js";

export type ToolBlockedStage =
  | "session-policy"
  | "security"
  | "rbac"
  | "tool-policy"
  | "threat"
  | "arikernel"
  | "approval";

export class ToolBlocked extends Error {
  readonly stage: ToolBlockedStage;
  readonly reason: string;
  readonly recovery?: string;
  /** Plain-English user-facing summary; see SecurityDecision.userHint. */
  readonly userHint?: string;
  constructor(details: { stage: ToolBlockedStage; reason: string; recovery?: string; userHint?: string }) {
    super(`BLOCKED by ${details.stage}: ${details.reason}`);
    this.name = "ToolBlocked";
    this.stage = details.stage;
    this.reason = details.reason;
    this.recovery = details.recovery;
    this.userHint = details.userHint;
  }
}

export interface ToolCallShape {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface PreDispatchCtx {
  sessionId: string;
  callContext: "local" | "api" | "delegated" | "cron";
  skipSessionPolicy?: boolean;
  security?: SecurityLayer;
  rbac?: { manager: RBACManager; role: Role };
  toolPolicy?: ToolPolicy;
  threatEngine?: ThreatEngine;
  approval?: { onEvent: (event: ServerEvent) => void; context?: string };
}

/** Map pack id → ToolBlocked stage so the existing caller-side stage map
 *  (in tool-executor.ts) keeps working unchanged. */
const PACK_TO_STAGE: Record<string, ToolBlockedStage> = {
  "security-layer": "security",
  "default-policy": "tool-policy",
  "threat-engine": "threat",
  "arikernel": "arikernel",
};

export async function assertToolCallAllowed(
  call: ToolCallShape,
  ctx: PreDispatchCtx,
): Promise<void> {
  // Per-session gate (not a rule pack — session-scoped runtime toggle).
  if (!ctx.skipSessionPolicy) {
    const sessionBlock = checkSessionPolicy(ctx.sessionId, call.name);
    if (sessionBlock) throw new ToolBlocked({ stage: "session-policy", reason: sessionBlock });
  }

  // Category-level kill-switches from Settings → Security → Tool Policy.
  // These sit ABOVE the rule packs so a flipped-off category short-circuits
  // before any rule eval. Cheap, predictable, user-visible.
  const cfg = getRuntimeConfig();
  // The shell kill-switch covers every shell-class tool, not just `bash`: the
  // process_* family spawns the same /bin/bash -c (or powershell) subprocess,
  // so leaving them on while Shell is off would be a silent bypass of the
  // user's own toggle.
  if ((call.name === "bash" || call.name.startsWith("process_")) && cfg.enableShell === false) {
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: "Shell Access is disabled in Settings → Security → Tool Policy.",
      recovery: "Shell is off. Tell the user, and ask if they'd like it on. If they confirm, call `setting` with enableShell=true. Don't re-enable it on your own just to get past this block. Other tools (write/edit/http_request) still work.",
      userHint: USER_HINTS.policy,
    });
  }
  if (call.name === "http_request" && cfg.enableHttp === false) {
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: "HTTP Requests are disabled in Settings → Security → Tool Policy.",
      recovery: "HTTP is off. Tell the user, and ask if they'd like it on. If they confirm, call `setting` with enableHttp=true. Don't re-enable it on your own just to get past this block.",
      userHint: USER_HINTS.policy,
    });
  }
  if (call.name.startsWith("browser") && cfg.enableBrowser === false) {
    throw new ToolBlocked({
      stage: "tool-policy",
      reason: "Browser is disabled in Settings → Security → Tool Policy.",
      recovery: "The browser is off. Tell the user, and ask if they'd like it on. If they confirm, call `setting` with enableBrowser=true. Don't re-enable it on your own just to get past this block.",
      userHint: USER_HINTS.policy,
    });
  }

  // Per-role gate (not a rule pack — RBAC is a principal property).
  if (ctx.rbac) {
    const d = ctx.rbac.manager.checkTool(ctx.rbac.role, call.name);
    if (!d.allowed) {
      throw new ToolBlocked({
        stage: "rbac",
        reason: d.reason,
        recovery:
          "This role lacks the permission to call this tool. Use a different tool or ask the user to elevate.",
        userHint: d.userHint ?? USER_HINTS.policy,
      });
    }
  }

  // Unified policy evaluation: one pass over the four rule packs.
  const packs: RulePack[] = [
    makeSecurityLayerPack(ctx.security),
    makeDefaultPolicyPack(ctx.toolPolicy),
    makeThreatEnginePack(ctx.threatEngine),
    makeArikernelPack(),
  ];
  const decision = await evaluatePolicy(
    { id: call.id, name: call.name, args: call.args },
    packs,
    { sessionId: ctx.sessionId, callContext: ctx.callContext },
  );
  if (!decision.allowed) {
    throw new ToolBlocked({
      stage: PACK_TO_STAGE[decision.deniedBy.packId] ?? "tool-policy",
      reason: decision.reason,
      recovery: decision.recovery,
      userHint: decision.userHint,
    });
  }

  // User-owned security controls (kill-switches, approval mode, browser mode)
  // may be changed when the user asks in an interactive session, but NEVER in
  // an autonomous run (cron/api/delegated sub-agent) where no user is present.
  // That autonomous block is the hard guarantee; the prompt-side rule "only
  // when the user asks" keeps the agent from flipping one on its own initiative
  // — e.g. re-enabling its own kill-switch to get past a block.
  if (
    call.name === "setting" &&
    isProtectedSetting(String((call.args as { field?: unknown }).field ?? "")) &&
    ctx.callContext !== "local"
  ) {
    const field = String((call.args as { field?: unknown }).field ?? "");
    throw new ToolBlocked({
      stage: "approval",
      reason: `"${field}" is a user-controlled security setting and cannot be changed in an automated/background run.`,
      recovery: "Security settings can only be changed when the user asks in an interactive chat. Surface this to the user instead.",
      userHint: USER_HINTS.policy,
    });
  }

  // Per-user gate (not a rule pack — interactive consent driven by the
  // active autonomy profile). The four-valued Decision branches into:
  // run silently, prompt the user, or block outright.
  if (ctx.approval && ctx.callContext === "local") {
    const decision = getToolDecision(call.name, ctx.sessionId);

    if (decisionDenies(decision)) {
      throw new ToolBlocked({
        stage: "approval",
        reason: `BLOCKED by profile: ${call.name} (risk class denied)`,
        userHint: USER_HINTS.policy,
      });
    }

    const destructive = isDestructiveCommand(call.name, call.args);
    if (decisionRequiresPrompt(decision) || destructive) {
      const approved = await getApprovalManager().requestApproval({
        toolName: call.name,
        toolCallId: call.id,
        sessionId: ctx.sessionId,
        context: destructive
          ? `⚠ Irreversible operation (${destructive}) — confirm before running. ${ctx.approval.context || ""}`
          : ctx.approval.context || "",
        args: call.args,
        alwaysAsk: !!destructive,
        emit: ctx.approval.onEvent,
      });
      if (!approved) {
        throw new ToolBlocked({
          stage: "approval",
          reason: `User declined (or did not confirm) ${call.name}. Do NOT re-issue this exact call — an identical retry is auto-declined this turn. Move on or report what you couldn't complete.`,
          recovery: `The user did not approve this action. Re-issuing the same call will not prompt again. Skip it and continue, or tell the user what you need them to approve.`,
          userHint: USER_HINTS.policy,
        });
      }
    }
  }
}
