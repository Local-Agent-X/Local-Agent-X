import { describe, it, expect } from "vitest";
import { cleanupVerifyMiddleware, opCleanupUnverified } from "./cleanup-verify.js";
import { _resetMiddlewareStates } from "./state.js";
import { setOpLedger, clearOpLedger } from "../instruction-ledger/index.js";
import { CLEANUP_VERIFY_MAX_NUDGES } from "../../agent-guards/index.js";
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

function bashSearchTurn(op: string, command: string, content: string, status: "ok" | "error" = "ok") {
  return cleanupVerifyMiddleware.afterToolExecution!(
    ctxFor(op, {
      toolCalls: [{ toolCallId: "b1", tool: "bash", args: { command } }],
      toolResults: [{ toolCallId: "b1", toolName: "bash", content, status }],
    } as Partial<CanonicalLoopContext>),
  );
}

function wrapUp(op: string, task = CLEANUP_TASK, text = "Done — all tailnet references removed.") {
  return cleanupVerifyMiddleware.afterModelCall!(
    ctxFor(op, { userMessage: task, toolCalls: [], assistantContent: text }),
  );
}

describe("cleanupVerifyMiddleware", () => {
  it("nudges repeatedly, bounded, when a cleanup wraps up with no clean search; a done-claim is retractable", async () => {
    _resetMiddlewareStates();
    const op = opId();
    for (let i = 1; i <= CLEANUP_VERIFY_MAX_NUDGES; i++) {
      const r = await wrapUp(op); // default text positively claims done
      expect(r).toMatchObject({ kind: "nudge", reason: "cleanup-verify-false-done" });
      expect(r.kind === "nudge" ? r.message : "").toContain(`${i}/${CLEANUP_VERIFY_MAX_NUDGES}`);
      expect(opCleanupUnverified(op)).toBe(true);
    }
    expect((await wrapUp(op)).kind).toBe("continue");
    expect(opCleanupUnverified(op)).toBe(true);
  });

  it("keeps nudging when the model re-greps but matches still remain", async () => {
    _resetMiddlewareStates();
    const op = opId();
    for (let i = 1; i <= CLEANUP_VERIFY_MAX_NUDGES; i++) {
      await grepTurn(op, `src/still-${i}.ts`);
      const r = await wrapUp(op);
      expect(r.kind).toBe("nudge");
      expect(r.kind === "nudge" ? r.message : "").toContain(`${i}/${CLEANUP_VERIFY_MAX_NUDGES}`);
      expect(opCleanupUnverified(op)).toBe(true);
    }
    await grepTurn(op, "src/still-final.ts");
    expect((await wrapUp(op)).kind).toBe("continue");
    expect(opCleanupUnverified(op)).toBe(true);
  });

  it("an honest 'not done' wrap-up nudges with the NON-retractable reason", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const r = await wrapUp(op, CLEANUP_TASK, "Not done yet — references still remain in app/src.");
    expect(r).toMatchObject({ kind: "nudge", reason: "cleanup-verify" });
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

  it("counts bash rg hits as unresolved cleanup evidence", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await bashSearchTurn(
      op,
      'rg -n "tailnet|tailscale" app/src',
      "[ok, exit_code=0, duration_ms=10]\napp/src/a.ts:1:tailnet",
      "ok",
    );
    const r = await wrapUp(op);
    expect(r.kind).toBe("nudge");
    expect(r.kind === "nudge" ? r.message : "").toContain("STILL returned matches");
    expect(opCleanupUnverified(op)).toBe(true);
  });

  it("counts bash rg exit 1 with no output as clean evidence", async () => {
    _resetMiddlewareStates();
    const op = opId();
    await bashSearchTurn(
      op,
      'rg -n "tailnet|tailscale" app/src',
      "[error, exit_code=1, duration_ms=10]\nExit code: 1",
      "error",
    );
    expect((await wrapUp(op)).kind).toBe("continue");
    expect(opCleanupUnverified(op)).toBe(false);
  });

  it("recovery: a clean grep after the nudge clears the verdict", async () => {
    _resetMiddlewareStates();
    const op = opId();
    expect((await wrapUp(op)).kind).toBe("nudge"); // unverified
    await grepTurn(op, "No matches found.");
    await wrapUp(op);                              // re-evaluate
    expect(opCleanupUnverified(op)).toBe(false);
  });

  it("suppresses the nudge under a workspace-write ban but keeps the label honest", async () => {
    _resetMiddlewareStates();
    const op = opId();
    // "don't edit, just tell me which tailnet refs remain" — the cleanup nudge
    // ("finish the hits, then re-grep") would push exactly the forbidden edits.
    setOpLedger(op, { prohibitions: ["workspace-write"], obligations: [], phrases: ["don't edit, just tell me"] });
    // The edit-pushing nudge is suppressed...
    expect((await wrapUp(op)).kind).toBe("continue");
    // ...but the outcome label still records the cleanup as unverified — a
    // read-only cleanup done-claim must NOT round up to `clean` (P2b).
    expect(opCleanupUnverified(op)).toBe(true);
    clearOpLedger(op);
    // Sanity: with the ledger cleared, the same unresolved state nudges again.
    expect((await wrapUp(op)).kind).toBe("nudge");
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
