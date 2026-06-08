import { describe, it, expect, afterEach } from "vitest";
import { requireApprovalPhase } from "./require-approval.js";
import type { ToolCallContext, CallContext } from "./context.js";
import { setSessionProfile, clearSessionProfile, inheritSessionProfile } from "../autonomy/profile-store.js";
import { getApprovalManager } from "../approval-manager.js";
import { classifyToolRisk } from "../autonomy/risk.js";
import type { ServerEvent } from "../types.js";

// Guard: these tests assume a stable risk mapping. If the classifier changes,
// the asserted profile tiers below must be revisited.
describe("risk-class assumptions", () => {
  it("http_request is network-write, read is not ask-tier", () => {
    expect(classifyToolRisk("http_request")).toBe("network-write");
    expect(classifyToolRisk("email_send")).toBe("external-comms");
  });
});

let _sid = 0;
function sid(): string {
  return `cron-test-${++_sid}-${process.hrtime.bigint().toString(36)}`;
}

function makeCtx(opts: {
  name: string;
  sessionId: string;
  callContext: CallContext;
  args?: Record<string, unknown>;
  onEvent?: (e: ServerEvent) => void;
}): ToolCallContext {
  return {
    tc: { id: `tc-${opts.name}`, name: opts.name, arguments: "{}" },
    sessionId: opts.sessionId,
    callContext: opts.callContext,
    args: opts.args ?? {},
    onEvent: opts.onEvent,
    approvalContext: "",
    riskLevel: "low",
    allowed: true,
    msgs: [],
    // Fields the approval phase never reads — cast keeps the test free of a
    // real SecurityLayer / tool map.
  } as unknown as ToolCallContext;
}

const sessions: string[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) clearSessionProfile(s);
});
function pinned(profile: Parameters<typeof setSessionProfile>[1]): string {
  const s = sid();
  setSessionProfile(s, profile);
  sessions.push(s);
  return s;
}

describe("requireApprovalPhase — unattended runs", () => {
  it("blocks an ask-tier tool in a cron run (no human to approve)", async () => {
    const s = pinned("Normal"); // network-write = ask under Normal
    const ctx = makeCtx({ name: "http_request", sessionId: s, callContext: "cron" });
    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("halt");
    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.status).toBe("blocked");
    expect(String(ctx.result?.content)).toContain("unattended");
  });

  it("blocks an ask-tier tool in a delegated run", async () => {
    const s = pinned("Normal");
    const ctx = makeCtx({ name: "email_send", sessionId: s, callContext: "delegated" });
    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("halt");
    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.status).toBe("blocked");
  });

  it("lets an allow-tier tool proceed in a cron run", async () => {
    const s = pinned("Normal"); // read is not ask-tier
    const ctx = makeCtx({ name: "read", sessionId: s, callContext: "cron" });
    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("continue");
    expect(ctx.result).toBeUndefined();
  });

  it("honors a per-job Autonomous profile so ask-tier tools run unattended", async () => {
    const s = pinned("Autonomous"); // external-comms = allow under Autonomous
    const ctx = makeCtx({ name: "email_send", sessionId: s, callContext: "cron" });
    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("continue");
    expect(ctx.allowed).toBe(true);
  });

  it("a sub-agent that inherited the parent's Autonomous profile runs ask-tier tools", async () => {
    // Cron parent pinned to Autonomous spawns a sub-agent: the delegated
    // session inherits the contract instead of falling back to global.
    const parent = pinned("Autonomous");
    const child = `agent-inherit-${++_sid}`;
    sessions.push(child);
    inheritSessionProfile(parent, child);

    const ctx = makeCtx({ name: "email_send", sessionId: child, callContext: "delegated" });
    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("continue");
    expect(ctx.allowed).toBe(true);
  });

  it("still prompts (not blocks) the same ask-tier tool in a local run", async () => {
    const s = pinned("Normal");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      name: "http_request",
      sessionId: s,
      callContext: "local",
      onEvent: (e) => {
        events.push(e);
        if (e.type === "approval_requested") {
          getApprovalManager().resolveApproval(e.approvalId, true);
        }
      },
    });
    const outcome = await requireApprovalPhase(ctx);

    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(outcome.kind).toBe("continue");
  });
});
