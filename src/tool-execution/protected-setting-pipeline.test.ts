// "Turn developer mode on" in the user's own chat was refused with "this
// session has no way to ask for approval" (2026-10-03): the tool pipeline
// gives the protected-setting gate no approval channel, and the gate read that
// as "nobody can be asked". The owner's rule is one click for a risky change.
// So the call goes through the live policy phase and the approval phase, as a
// dispatcher runs it: a gate the dispatcher reaches only in unit tests passes
// them while the card it promises never appears.
import { afterEach, describe, expect, it } from "vitest";
import { settingTool } from "../tools/setting-tool.js";
import { enforcePolicyPhase } from "./enforce-policy.js";
import { requireApprovalPhase } from "./require-approval.js";
import { getApprovalManager } from "../approval-manager.js";
import { clearSessionProfile, setSessionProfile } from "../autonomy/profile-store.js";
import { createContext, type CallContext, type PhaseOutcome, type ToolCallContext } from "./context.js";
import type { SecurityLayer } from "../security/index.js";
import type { ServerEvent } from "../types.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const undo of cleanup.splice(0)) undo(); });

function session(profile: "Power" | "Autonomous"): string {
  const s = `protected-pipeline-${profile}-${process.hrtime.bigint().toString(36)}`;
  setSessionProfile(s, profile);
  cleanup.push(() => clearSessionProfile(s));
  return s;
}

async function dispatch(args: Record<string, unknown>, opts: { sessionId: string; callContext?: CallContext; onEvent?: (e: ServerEvent) => void }): Promise<{ c: ToolCallContext; policy: PhaseOutcome; approval: PhaseOutcome | null }> {
  const c = createContext({
    tc: { id: `tc-setting-${Math.random().toString(36).slice(2)}`, name: settingTool.name, arguments: JSON.stringify(args) },
    toolMap: new Map([[settingTool.name, settingTool]]),
    security: { evaluate: () => ({ allowed: true, reason: "" }) } as unknown as SecurityLayer,
    sessionId: opts.sessionId,
    callContext: opts.callContext ?? "local",
    onEvent: opts.onEvent,
  });
  c.args = { ...args };
  const policy = await enforcePolicyPhase(c);
  return { c, policy, approval: policy.kind === "continue" ? await requireApprovalPhase(c) : null };
}

describe("turning developer mode on from the user's chat", () => {
  it.each(["Power", "Autonomous"] as const)("shows one card naming the change on %s, and runs on yes", async (profile) => {
    const cards: Array<Extract<ServerEvent, { type: "approval_requested" }>> = [];
    const { approval } = await dispatch({ field: "developer_mode", value: true }, {
      sessionId: session(profile),
      onEvent: (e) => {
        if (e.type !== "approval_requested") return;
        cards.push(e);
        getApprovalManager().resolveApproval(e.approvalId, true);
      },
    });
    expect(approval?.kind).toBe("continue");
    expect(cards).toHaveLength(1);
    expect(cards[0].context).toMatch(/developer mode/i);
  });

  it("does not run when the user declines", async () => {
    const { c, approval } = await dispatch({ field: "developer_mode", value: true }, {
      sessionId: session("Autonomous"),
      onEvent: (e) => { if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, false); },
    });
    expect(approval?.kind).toBe("halt");
    expect(c.allowed).toBe(false);
  });

  it("is refused outright in an unattended run, with no card", async () => {
    const cards: ServerEvent[] = [];
    const { c, policy, approval } = await dispatch({ field: "developer_mode", value: true }, {
      sessionId: session("Autonomous"),
      callContext: "cron",
      onEvent: (e) => { if (e.type === "approval_requested") cards.push(e); },
    });
    expect(policy.kind).not.toBe("continue");
    expect(approval).toBeNull();
    expect(c.result?.status).toBe("blocked");
    expect(cards).toEqual([]);
  });

  it("turning it off needs no card", async () => {
    const cards: ServerEvent[] = [];
    const { approval } = await dispatch({ field: "developer_mode", value: false }, {
      sessionId: session("Power"),
      onEvent: (e) => { if (e.type === "approval_requested") cards.push(e); },
    });
    expect(approval?.kind).toBe("continue");
    expect(cards).toEqual([]);
  });
});
