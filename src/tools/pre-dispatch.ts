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
import type { SecurityLayer } from "../security.js";
import { checkSessionPolicy } from "../session-policy.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import { getApprovalManager, toolNeedsApproval } from "../approval-manager.js";
import type { ServerEvent } from "../types.js";
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
  constructor(details: { stage: ToolBlockedStage; reason: string; recovery?: string }) {
    super(`BLOCKED by ${details.stage}: ${details.reason}`);
    this.name = "ToolBlocked";
    this.stage = details.stage;
    this.reason = details.reason;
    this.recovery = details.recovery;
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

  // Per-role gate (not a rule pack — RBAC is a principal property).
  if (ctx.rbac) {
    const d = ctx.rbac.manager.checkTool(ctx.rbac.role, call.name);
    if (!d.allowed) {
      throw new ToolBlocked({
        stage: "rbac",
        reason: d.reason,
        recovery:
          "This role lacks the permission to call this tool. Use a different tool or ask the user to elevate.",
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
    });
  }

  // Per-user gate (not a rule pack — approval is interactive consent).
  if (ctx.approval && toolNeedsApproval(call.name) && ctx.callContext === "local") {
    const approved = await getApprovalManager().requestApproval({
      toolName: call.name,
      toolCallId: call.id,
      sessionId: ctx.sessionId,
      context: ctx.approval.context || "",
      args: call.args,
      emit: ctx.approval.onEvent,
    });
    if (!approved) {
      throw new ToolBlocked({
        stage: "approval",
        reason: `declined approval for ${call.name}`,
      });
    }
  }
}
