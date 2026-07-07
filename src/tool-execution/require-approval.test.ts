import { describe, it, expect, afterEach, vi } from "vitest";
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
  policyApprovalReason?: string;
}): ToolCallContext {
  return {
    tc: { id: `tc-${opts.name}`, name: opts.name, arguments: "{}" },
    sessionId: opts.sessionId,
    callContext: opts.callContext,
    args: opts.args ?? {},
    onEvent: opts.onEvent,
    approvalContext: "",
    policyApprovalReason: opts.policyApprovalReason,
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
  it("prompts once when a policy rule requires approval even if the profile allows", async () => {
    const s = pinned("Power");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      name: "browser",
      sessionId: s,
      callContext: "local",
      args: { action: "evaluate", script: "document.title" },
      policyApprovalReason: "Browser JS evaluation requires review",
      onEvent: (e) => {
        events.push(e);
        if (e.type === "approval_requested") {
          getApprovalManager().resolveApproval(e.approvalId, true);
        }
      },
    });

    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("continue");
    expect(events.filter((e) => e.type === "approval_requested")).toHaveLength(1);
  });

  it("does not bypass a profile hard deny when policy asks for approval", async () => {
    const s = pinned("Safe");
    const ctx = makeCtx({
      name: "delete_file",
      sessionId: s,
      callContext: "local",
      args: { path: "C:/tmp/example.txt" },
      policyApprovalReason: "Deletion requires review",
    });

    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.status).toBe("blocked");
  });

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

describe("requireApprovalPhase — user decline is 'declined', not 'blocked'", () => {
  // Regression: the user-decline branch used to return status "blocked",
  // collapsing "a human said no to this call" into "policy forbids this" —
  // the model would conclude the tool was dead instead of adjusting.
  it("a declined approval yields status 'declined' with no-retry guidance", async () => {
    const s = pinned("Normal"); // http_request = ask under Normal
    const ctx = makeCtx({
      name: "http_request",
      sessionId: s,
      callContext: "local",
      onEvent: (e) => {
        if (e.type === "approval_requested") {
          getApprovalManager().resolveApproval(e.approvalId, false);
        }
      },
    });
    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("halt");
    expect(ctx.allowed).toBe(false);
    expect(ctx.result?.status).toBe("declined");
    expect(ctx.result?.isError).toBe(true);
    expect(ctx.result?.metadata?.layer).toBe("approval");
    expect(String(ctx.result?.content)).toContain("DECLINED by user");
    expect(String(ctx.result?.content)).toContain("Do not immediately retry the same call");
    expect(String(ctx.result?.content)).toContain("you may request approval again");
  });

  // Regression (skeptic Finding A): requestApproval resolves false on THREE
  // paths — only the Deny click is a human "no". A timed-out card must not
  // report "DECLINED by user".
  it("an approval TIMEOUT yields 'blocked' with timeout wording, not 'declined'", async () => {
    vi.useFakeTimers();
    try {
      const s = pinned("Normal");
      const ctx = makeCtx({
        name: "http_request",
        sessionId: s,
        callContext: "local",
        onEvent: () => { /* nobody answers the card */ },
      });
      const pending = requireApprovalPhase(ctx);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1); // real requestApproval deadline
      const outcome = await pending;

      expect(outcome.kind).toBe("halt");
      expect(ctx.result?.status).toBe("blocked");
      expect(ctx.result?.isError).toBe(true);
      expect(String(ctx.result?.content)).toContain("timed out");
      expect(String(ctx.result?.content)).toContain("Do not assume consent");
      expect(String(ctx.result?.content)).not.toContain("DECLINED by user");
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression (skeptic round 2): the suppression map used to store only a
  // timestamp, so a re-issue of a TIMED-OUT call inside the 60s suppression
  // window replayed a fabricated "DECLINED by user". The map now stores the
  // reason and the short-circuit replays it.
  it("re-issuing a call that TIMED OUT (within suppression window) replays timeout, NOT 'declined'", async () => {
    vi.useFakeTimers();
    try {
      const s = pinned("Normal");
      const events: string[] = [];
      const mk = () => makeCtx({
        name: "http_request",
        sessionId: s,
        callContext: "local",
        onEvent: (e) => { events.push(e.type); /* nobody answers */ },
      });

      const first = mk();
      const p1 = requireApprovalPhase(first);
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await p1;
      expect(first.result?.status).toBe("blocked");
      expect(String(first.result?.content)).toContain("timed out");

      // Identical re-issue moments later — suppression short-circuits (no
      // new card) and MUST keep telling the truth.
      const cardsBefore = events.filter((t) => t === "approval_requested").length;
      const second = mk();
      await requireApprovalPhase(second);
      expect(events.filter((t) => t === "approval_requested").length).toBe(cardsBefore);
      expect(second.result?.status).toBe("blocked");
      expect(String(second.result?.content)).toContain("timed out");
      expect(String(second.result?.content)).not.toContain("DECLINED by user");
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-issuing a call the user DECLINED (within suppression window) is still 'declined'", async () => {
    const s = pinned("Normal");
    const events: string[] = [];
    const mk = () => makeCtx({
      name: "http_request",
      sessionId: s,
      callContext: "local",
      onEvent: (e) => {
        events.push(e.type);
        if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, false);
      },
    });

    const first = mk();
    await requireApprovalPhase(first);
    expect(first.result?.status).toBe("declined");

    const cardsBefore = events.filter((t) => t === "approval_requested").length;
    const second = mk();
    await requireApprovalPhase(second);
    // Suppressed silently — no second card — and still an honest decline.
    expect(events.filter((t) => t === "approval_requested").length).toBe(cardsBefore);
    expect(second.result?.status).toBe("declined");
    expect(String(second.result?.content)).toContain("DECLINED by user");
  });

  it("clearSession teardown leaves NO suppression: an immediate re-request gets a fresh card", async () => {
    const s = pinned("Normal");
    const first = makeCtx({
      name: "http_request",
      sessionId: s,
      callContext: "local",
      onEvent: (e) => {
        // Session tears down while the card is pending.
        if (e.type === "approval_requested") getApprovalManager().clearSession(s);
      },
    });
    await requireApprovalPhase(first);
    expect(first.result?.status).toBe("blocked");
    expect(String(first.result?.content)).not.toContain("DECLINED by user");

    // A successor request on the same key must get a FRESH card (no leaked
    // 60s suppression), and approving it must work.
    setSessionProfile(s, "Normal");
    let sawCard = false;
    const second = makeCtx({
      name: "http_request",
      sessionId: s,
      callContext: "local",
      onEvent: (e) => {
        if (e.type === "approval_requested") {
          sawCard = true;
          getApprovalManager().resolveApproval(e.approvalId, true);
        }
      },
    });
    const outcome = await requireApprovalPhase(second);
    expect(sawCard).toBe(true);
    expect(outcome.kind).toBe("continue");
  });

  it("a card SUPERSEDED by a chat reply (denyPendingForSession) yields 'blocked' with re-read wording", async () => {
    const s = pinned("Normal");
    const ctx = makeCtx({
      name: "http_request",
      sessionId: s,
      callContext: "local",
      onEvent: (e) => {
        if (e.type === "approval_requested") {
          // The user typed a message instead of clicking the card.
          getApprovalManager().denyPendingForSession(s);
        }
      },
    });
    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.status).toBe("blocked");
    expect(String(ctx.result?.content)).toContain("replied in chat");
    expect(String(ctx.result?.content)).toContain("Re-read their latest message");
    expect(String(ctx.result?.content)).not.toContain("DECLINED by user");
  });

  it("profile deny and unattended block STAY 'blocked' (absent human ≠ human said no)", async () => {
    const denied = makeCtx({ name: "delete_file", sessionId: pinned("Safe"), callContext: "local", args: { path: "C:/tmp/x.txt" } });
    await requireApprovalPhase(denied);
    expect(denied.result?.status).toBe("blocked");

    const unattended = makeCtx({ name: "http_request", sessionId: pinned("Normal"), callContext: "cron" });
    await requireApprovalPhase(unattended);
    expect(unattended.result?.status).toBe("blocked");
  });
});

describe("requireApprovalPhase — destructive reclassification", () => {
  // The profile table is the single source of truth: a destructive operation
  // is decided by the profile's destructive tier, with no confirm floor above
  // it. Power promises "autonomous for everything except money and secrets" —
  // delete_file under Power prompting was a broken promise (2026-06-10).
  it("Power runs delete_file with NO prompt (destructive=allow)", async () => {
    const s = pinned("Power");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      name: "delete_file", sessionId: s, callContext: "local",
      args: { path: "C:/tmp/x.pptx" }, onEvent: (e) => events.push(e),
    });
    const outcome = await requireApprovalPhase(ctx);

    expect(outcome.kind).toBe("continue");
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
  });

  it("Normal still prompts for delete_file (destructive=ask)", async () => {
    const s = pinned("Normal");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      name: "delete_file", sessionId: s, callContext: "local",
      args: { path: "C:/tmp/x.pptx" },
      onEvent: (e) => {
        events.push(e);
        if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, true);
      },
    });
    const outcome = await requireApprovalPhase(ctx);

    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(outcome.kind).toBe("continue");
  });

  it("bash rm -rf is decided by the destructive tier, not the coarse shell grant", async () => {
    // Normal: shell=allow but destructive=ask — the reclassification is what
    // makes rm -rf prompt while git status runs silently.
    const s = pinned("Normal");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      name: "bash", sessionId: s, callContext: "local",
      args: { command: "rm -rf /tmp/x" },
      onEvent: (e) => {
        events.push(e);
        if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, false);
      },
    });
    const outcome = await requireApprovalPhase(ctx);
    expect(events.some((e) => e.type === "approval_requested")).toBe(true);
    expect(outcome.kind).toBe("halt");

    // Power: destructive=allow, BUT rm -rf is irreversible — the floor forces
    // one confirm even under Power ("never something it can't undo"). Decline → halt.
    const s2 = pinned("Power");
    const events2: ServerEvent[] = [];
    const ctx2 = makeCtx({
      name: "bash", sessionId: s2, callContext: "local",
      args: { command: "rm -rf /tmp/x" },
      onEvent: (e) => {
        events2.push(e);
        if (e.type === "approval_requested") getApprovalManager().resolveApproval(e.approvalId, false);
      },
    });
    const outcome2 = await requireApprovalPhase(ctx2);
    expect(events2.some((e) => e.type === "approval_requested")).toBe(true);
    expect(outcome2.kind).toBe("halt");

    // The floor is scoped: a non-irreversible command under Power still runs
    // silently — no nagging on recoverable work.
    const s3 = pinned("Power");
    const events3: ServerEvent[] = [];
    const ctx3 = makeCtx({
      name: "bash", sessionId: s3, callContext: "local",
      args: { command: "echo hi" }, onEvent: (e) => events3.push(e),
    });
    const outcome3 = await requireApprovalPhase(ctx3);
    expect(outcome3.kind).toBe("continue");
    expect(events3.some((e) => e.type === "approval_requested")).toBe(false);
  });

  it("the irreversible floor does NOT fire in an unattended (non-local) run", async () => {
    // Unattended stays governed by the profile so explicit automation isn't
    // broken: Power's destructive=allow runs rm -rf without prompting (there's
    // no human to confirm). The floor is interactive-only.
    const s = pinned("Power");
    const events: ServerEvent[] = [];
    const ctx = makeCtx({
      name: "bash", sessionId: s, callContext: "cron",
      args: { command: "rm -rf /tmp/x" }, onEvent: (e) => events.push(e),
    });
    const outcome = await requireApprovalPhase(ctx);
    expect(outcome.kind).toBe("continue");
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
  });

  it("Safe denies a destructive operation outright (destructive=deny)", async () => {
    const s = pinned("Safe");
    const ctx = makeCtx({
      name: "bash", sessionId: s, callContext: "local",
      args: { command: "rm -rf /tmp/x" },
    });
    const outcome = await requireApprovalPhase(ctx);
    expect(outcome.kind).toBe("halt");
    expect(ctx.result?.status).toBe("blocked");
  });
});
