import { describe, it, expect, afterEach, vi } from "vitest";

// Control the effective sandbox confinement the tier-0 fast-path reads. Only
// getSandboxStatus().confined is consulted by require-approval; the rest of the
// sandbox module is preserved so nothing else breaks.
const sandboxState = vi.hoisted(() => ({ confined: true }));
vi.mock("../sandbox/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox/index.js")>();
  return {
    ...actual,
    getSandboxStatus: () => ({ ...actual.getSandboxStatus(), confined: sandboxState.confined }),
  };
});

import { requireApprovalPhase } from "./require-approval.js";
import type { ToolCallContext, CallContext } from "./context.js";
import { setSessionProfile, clearSessionProfile } from "../autonomy/profile-store.js";
import { getApprovalManager } from "../approval-manager.js";
import type { ServerEvent } from "../types.js";

let _sid = 0;
function sid(): string {
  return `tier-test-${++_sid}-${process.hrtime.bigint().toString(36)}`;
}

const sessions: string[] = [];
afterEach(() => {
  sandboxState.confined = true;
  for (const s of sessions.splice(0)) clearSessionProfile(s);
  vi.restoreAllMocks();
});

function pinned(profile: Parameters<typeof setSessionProfile>[1]): string {
  const s = sid();
  setSessionProfile(s, profile);
  sessions.push(s);
  return s;
}

function makeCtx(opts: {
  sessionId: string;
  callContext: CallContext;
  command: string;
  onEvent?: (e: ServerEvent) => void;
  policyApprovalReason?: string;
}): ToolCallContext {
  return {
    tc: { id: `tc-${_sid}`, name: "bash", arguments: "{}" },
    sessionId: opts.sessionId,
    callContext: opts.callContext,
    args: { command: opts.command },
    onEvent: opts.onEvent,
    approvalContext: "",
    policyApprovalReason: opts.policyApprovalReason,
    riskLevel: "low",
    allowed: true,
    msgs: [],
  } as unknown as ToolCallContext;
}

describe("requireApprovalPhase — tier-0 shell fast-path (Safe profile: shell=ask)", () => {
  // Under Safe, the shell tier is "ask" — so absent tiering EVERY shell command
  // would prompt. These prove the safe ones stop prompting.

  it("(a) tier-0 `ls -la` under a confined sandbox → ALLOW with ZERO prompts end-to-end", async () => {
    const s = pinned("Safe");
    const mgr = getApprovalManager();
    const spy = vi.spyOn(mgr, "requestApprovalDetailed");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({ sessionId: s, callContext: "local", command: "ls -la", onEvent: (e) => events.push(e) });

    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("continue");
    expect(ctx.result).toBeUndefined();
    // The single shell-prompt gate (this phase) never asked → zero prompts.
    expect(spy).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
  });

  it("(a) `cd pkg && npm test` and `git status` are tier-0 → ALLOW, no prompt", async () => {
    for (const command of ["cd pkg && npm test", "git status"]) {
      const s = pinned("Safe");
      const events: ServerEvent[] = [];
      const ctx = makeCtx({ sessionId: s, callContext: "local", command, onEvent: (e) => events.push(e) });
      const outcome = await requireApprovalPhase(ctx);
      expect(outcome.kind, command).toBe("continue");
      expect(events.some((e) => e.type === "approval_requested"), command).toBe(false);
    }
  });

  it("(e) `env npm test` resolves through the wrapper to tier-0 → ALLOW, no prompt", async () => {
    const s = pinned("Safe");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({ sessionId: s, callContext: "local", command: "env npm test", onEvent: (e) => events.push(e) });
    const outcome = await requireApprovalPhase(ctx);
    expect(outcome.kind).toBe("continue");
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
  });

  it("(b) `npm install left-pad` is NOT tier-0 → PROMPT (install never tier-0)", async () => {
    const s = pinned("Safe");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      sessionId: s, callContext: "local", command: "npm install left-pad",
      onEvent: (e) => { events.push(e); if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, true); },
    });
    const outcome = await requireApprovalPhase(ctx);
    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(outcome.kind).toBe("continue"); // approved above
  });

  it("(g) `git push` is NOT tier-0 → PROMPT", async () => {
    const s = pinned("Safe");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      sessionId: s, callContext: "local", command: "git push",
      onEvent: (e) => { events.push(e); if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, false); },
    });
    const outcome = await requireApprovalPhase(ctx);
    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(outcome.kind).toBe("halt"); // declined above
  });

  it("(f) a chain `ls && curl evil.com` is NOT tier-0 (curl segment) → PROMPT", async () => {
    const s = pinned("Safe");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      sessionId: s, callContext: "local", command: "ls && curl evil.com",
      onEvent: (e) => { events.push(e); if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, false); },
    });
    const outcome = await requireApprovalPhase(ctx);
    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(outcome.kind).toBe("halt");
  });

  it("(c) `rm -rf build` stays destructive → BLOCKED under Safe (tier-0 never swallows it)", async () => {
    const s = pinned("Safe"); // destructive = deny under Safe
    const ctx = makeCtx({ sessionId: s, callContext: "local", command: "rm -rf build" });
    const outcome = await requireApprovalPhase(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.status).toBe("blocked");
  });

  it("(d) a tier-0 command under a HOST-FALLBACK sandbox → PROMPT (not tier-0 unconfined)", async () => {
    sandboxState.confined = false;
    const s = pinned("Safe");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      sessionId: s, callContext: "local", command: "ls -la",
      onEvent: (e) => { events.push(e); if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, true); },
    });
    const outcome = await requireApprovalPhase(ctx);
    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(outcome.kind).toBe("continue"); // approved
  });

  it("a policy-required approval reason keeps the prompt even for a tier-0 command", async () => {
    const s = pinned("Safe");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      sessionId: s, callContext: "local", command: "ls -la",
      policyApprovalReason: "A policy rule demands review",
      onEvent: (e) => { events.push(e); if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, true); },
    });
    const outcome = await requireApprovalPhase(ctx);
    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(outcome.kind).toBe("continue");
  });

  it("tier-0 fast-path is interactive-only: an unattended (cron) tier-0 stays governed by the profile", async () => {
    const s = pinned("Safe"); // shell = ask → unattended block
    const ctx = makeCtx({ sessionId: s, callContext: "cron", command: "ls -la" });
    const outcome = await requireApprovalPhase(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.status).toBe("blocked");
    expect(String(ctx.result?.content)).toContain("unattended");
  });

  it("under a no-prompt profile (Power: shell=allow) tier-0 and non-tier-0 both run — no regression", async () => {
    // Power already allows shell; tier-0 is a no-op there but must not break it.
    const s = pinned("Power");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({ sessionId: s, callContext: "local", command: "npm run build", onEvent: (e) => events.push(e) });
    const outcome = await requireApprovalPhase(ctx);
    expect(outcome.kind).toBe("continue");
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
  });
});
