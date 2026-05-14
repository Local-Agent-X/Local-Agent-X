/**
 * Pre-dispatch gate chain — the checks every tool call must pass before
 * execution, regardless of which dispatcher routed it. Both the chat-path
 * (src/tool-executor.ts) and the AriKernel-path
 * (packages/arikernel/tool-executors/*) call this, closing F3 from DRY-AUDIT.md.
 * Each gate is conditional on its ctx field; throws ToolBlocked on first deny.
 */
import type { SecurityLayer } from "../security.js";
import { checkSessionPolicy } from "../session-policy.js";
import type { ToolPolicy } from "../tool-policy.js";
import type { ThreatEngine } from "../threat-engine.js";
import type { RBACManager, Role } from "../rbac.js";
import { getApprovalManager, toolNeedsApproval } from "../approval-manager.js";
import type { ServerEvent } from "../types.js";

export type ToolBlockedStage =
  | "session-policy"
  | "security"
  | "rbac"
  | "tool-policy"
  | "threat"
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

const RESTRICTED_EXTERNAL_TOOLS = new Set(["http_request", "web_fetch", "browser"]);

function isOwnAppBrowserCall(args: Record<string, unknown>): boolean {
  const urlArg = String(args.url || "");
  const appPort = process.env.LAX_PORT ?? process.env.SAX_PORT ?? "7007";
  return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${appPort}`, "i").test(urlArg);
}

export async function assertToolCallAllowed(
  call: ToolCallShape,
  ctx: PreDispatchCtx,
): Promise<void> {
  if (!ctx.skipSessionPolicy) {
    const sessionBlock = checkSessionPolicy(ctx.sessionId, call.name);
    if (sessionBlock) throw new ToolBlocked({ stage: "session-policy", reason: sessionBlock });
  }

  if (ctx.security) {
    const d = ctx.security.evaluate({
      toolName: call.name,
      args: call.args,
      sessionId: ctx.sessionId,
      callContext: ctx.callContext,
    });
    if (!d.allowed) {
      throw new ToolBlocked({
        stage: "security",
        reason: d.reason,
        recovery:
          "Adjust the call to stay within the workspace and security boundaries — retrying the same args will be denied again.",
      });
    }
  }

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

  if (ctx.toolPolicy) {
    const d = ctx.toolPolicy.evaluate(call.name, call.args, ctx.sessionId);
    if (!d.allowed) {
      throw new ToolBlocked({
        stage: "tool-policy",
        reason: d.reason,
        recovery:
          "Retrying the same call will be denied again. Read the reason — it usually points to the right alternative tool (e.g. http_request instead of bash curl).",
      });
    }
  }

  if (
    ctx.threatEngine?.isRestricted() &&
    RESTRICTED_EXTERNAL_TOOLS.has(call.name) &&
    !(call.name === "browser" && isOwnAppBrowserCall(call.args))
  ) {
    throw new ToolBlocked({
      stage: "threat",
      reason: "Session threat level elevated. External tool calls restricted.",
    });
  }

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
