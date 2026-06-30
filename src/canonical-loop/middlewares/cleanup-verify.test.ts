import { describe, it, expect } from "vitest";
import { cleanupVerifyMiddleware, opCleanupUnverified } from "./cleanup-verify.js";
import { _resetMiddlewareStates } from "./state.js";
import type { CanonicalLoopContext } from "./types.js";

let _op = 0;
function opId(): string { return `op-cv-test-${++_op}`; }

const CLEANUP_TASK =
  "We moved off Tailscale — go through the project and remove every tailnet reference left over in the code.";

function ctxFor(op: string, over: Partial<CanonicalLoopContext>): CanonicalLoopContext {
  return {
    op: { id: op, lane: "interactive", type: "chat_turn" },
    turnIdx: 1,
    userMessage: CLEANUP_TASK,
    assistantContent: "",
    toolCalls: [],
    toolResults: [],
    ...over,
  } as unknown as CanonicalLoopContext;
}

function grepTurn(op: string, content: string, status: "ok" | "error" = "ok") {
  return cleanupVerifyMiddleware.afterToolExecution!(
    ctxFor(op, {
      toolCalls: [{ toolCallId: "g1", tool: "grep", args: { pattern: "tailnet" } }],
      toolResults: [{ toolCallId: "g1", toolName: "grep", content, status }],
    } as Partial<CanonicalLoopContext>),
  );
}

function wrapUp(op: string, task = CLEANUP_TASK) {
  return cleanupVerifyMiddleware.afterModelCall!(
    ctxFor(op, { userMessage: task, toolCalls: [], assistantContent: "Done — all tailnet references removed." }),
  );
}

describe("cleanupVerifyMiddleware", () => {
  it("nudges once when a cleanup wraps up with no clean search", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const r = await wrapUp(op);
    expect(r).toMatchObject({ kind: "nudge", reason: "cleanup-verify" });
    expect(opCleanupUnverified(op)).toBe(true);
    // fire-once
    expect((await wrapUp(op)).kind).toBe("continue");
    expect(opCleanupUnverified(op)).toBe(true);
  });

  it("stays quiet when a grep came back empty before wrap-up", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await grepTurn(op, "No matches found.");
    expect((await wrapUp(op)).kind).toBe("continue");
    expect(opCleanupUnverified(op)).toBe(false);
  });

  it("a grep that still has matches does not count as verified", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await grepTurn(op, "src/a.ts\nsrc/b.ts");
    expect((await wrapUp(op)).kind).toBe("nudge");
    expect(opCleanupUnverified(op)).toBe(true);
  });

  it("recovery: a clean grep after the nudge clears the verdict", async () => {
    _resetMiddlewareStates();
    const op = opId();
    expect((await wrapUp(op)).kind).toBe("nudge"); // unverified
    await grepTurn(op, "No matches found.");
    await wrapUp(op);                              // re-evaluate
    expect(opCleanupUnverified(op)).toBe(false);
  });

  it("stays quiet on a non-cleanup task", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const r = await wrapUp(op, "Add a logout button to the settings page.");
    expect(r.kind).toBe("continue");
    expect(opCleanupUnverified(op)).toBe(false);
  });

  it("stays quiet while the model is still calling tools this turn", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const r = await cleanupVerifyMiddleware.afterModelCall!(
      ctxFor(op, {
        toolCalls: [{ toolCallId: "x", tool: "read", args: {} }],
        assistantContent: "checking one more thing",
      } as Partial<CanonicalLoopContext>),
    );
    expect(r.kind).toBe("continue");
  });

  it("defaults to verified-enough for an op the gate never evaluated", () => {
    _resetMiddlewareStates();
    expect(opCleanupUnverified("never-seen-op")).toBe(false);
  });
});
