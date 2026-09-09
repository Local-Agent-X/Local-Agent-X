import { describe, it, expect, vi } from "vitest";
import {
  cleanupVerifyMiddleware,
  createCleanupVerifyMiddleware,
  opCleanupUnverified,
} from "./cleanup-verify.js";
import { _resetMiddlewareStates, getMiddlewareState } from "./state.js";
import { setOpLedger, clearOpLedger } from "../instruction-ledger/index.js";
import {
  CLEANUP_VERIFY_MAX_NUDGES,
  looksLikeCleanupSweep,
  createCleanupVerifyState,
  type CleanupVerifyState,
} from "../../agent-guards/index.js";
import type { CanonicalLoopContext, CanonicalMiddleware } from "./types.js";
import { makeCanonicalLoopContext } from "./ctx.test-helper.js";

// The default instance's confirm routes through classifyYesNo. Unit tests must
// never reach a live provider: mocked to null = "classifier unavailable", which
// fails open to the deterministic regex verdict — exactly today's behavior, so
// the pre-existing tests below pin the same contract they always did (a
// regex-flagged done-claim still retracts).
vi.mock("../../classifiers/classify-with-llm.js", () => ({
  classifyYesNo: vi.fn(async () => null),
}));

let _op = 0;
function opId(): string { return `op-cv-test-${++_op}`; }

const CLEANUP_TASK =
  "We moved off Tailscale — go through the project and remove every tailnet reference left over in the code.";

function ctxFor(op: string, over: Partial<CanonicalLoopContext>): CanonicalLoopContext {
  return makeCanonicalLoopContext({
    op: { id: op, lane: "interactive", type: "chat_turn" },
    turnIdx: 1,
    currentUserMessage: CLEANUP_TASK,
    assistantContent: "",
    toolCalls: [],
    toolResults: [],
    ...over,
  });
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
    ctxFor(op, { currentUserMessage: task, toolCalls: [], assistantContent: text }),
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

describe("LLM confirm gates the FALSE-DONE retract (regex is the prefilter)", () => {
  // Drive an injected-confirm instance through the same wrap-up path. The
  // default text ("all tailnet references removed") trips claimsCleanupDone, so
  // the retract branch is exercised; no clean grep ran, so a nudge is due.
  function wrapUpWith(
    mw: CanonicalMiddleware,
    op: string,
    text = "Done — all tailnet references removed.",
  ) {
    return mw.afterModelCall!(
      ctxFor(op, { currentUserMessage: CLEANUP_TASK, toolCalls: [], assistantContent: text }),
    );
  }

  it("confirmed-false downgrades to the non-retract reason (still nudges, no retract)", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const mw = createCleanupVerifyMiddleware(async () => false);
    const r = await wrapUpWith(mw, op);
    // The re-grep nudge is still warranted — only the RETRACT is suppressed.
    expect(r).toMatchObject({ kind: "nudge", reason: "cleanup-verify" });
    expect(opCleanupUnverified(op)).toBe(true);
  });

  it("confirmed-true retracts exactly as today", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const mw = createCleanupVerifyMiddleware(async () => true);
    const r = await wrapUpWith(mw, op);
    expect(r).toMatchObject({ kind: "nudge", reason: "cleanup-verify-false-done" });
    expect(opCleanupUnverified(op)).toBe(true);
  });

  it("fails open: null confirm (timeout/disabled) retracts exactly as today", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const mw = createCleanupVerifyMiddleware(async () => null);
    const r = await wrapUpWith(mw, op);
    expect(r).toMatchObject({ kind: "nudge", reason: "cleanup-verify-false-done" });
  });

  it("fails open: a confirm that throws retracts exactly as today", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const mw = createCleanupVerifyMiddleware(async () => { throw new Error("provider down"); });
    const r = await wrapUpWith(mw, op);
    expect(r).toMatchObject({ kind: "nudge", reason: "cleanup-verify-false-done" });
  });

  it("paraphrase-blindness fix: 'we got everything that mattered' with confirm=false is NOT retracted", async () => {
    // The regex prefilter DOES flag this ('all ... done'-shaped), yet it isn't a
    // clean-sweep done-claim; before the confirm gate that retracted a bubble the
    // model never meant as final. Confirm=false keeps the honest, non-retract reason.
    _resetMiddlewareStates();
    const op = opId();
    const mw = createCleanupVerifyMiddleware(async () => false);
    const r = await wrapUpWith(mw, op, "All set — we got everything that mattered.");
    expect(r).toMatchObject({ kind: "nudge", reason: "cleanup-verify" });
  });

  it("never calls the confirm when the wrap-up isn't a done-claim (honest 'not done')", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const confirm = vi.fn(async () => true);
    const mw = createCleanupVerifyMiddleware(confirm);
    const r = await wrapUpWith(mw, op, "Not done yet — references still remain in app/src.");
    expect(r).toMatchObject({ kind: "nudge", reason: "cleanup-verify" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("hands the confirm the full wrap-up text", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const seen: string[] = [];
    const mw = createCleanupVerifyMiddleware(async (text) => { seen.push(text); return false; });
    const reply = "Done — all tailnet references removed.";
    await wrapUpWith(mw, op, reply);
    expect(seen).toEqual([reply]);
  });

  it("a suppressed retract does not burn the per-op nudge budget — later wrap-ups still nudge to the cap", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const mw = createCleanupVerifyMiddleware(async () => false);
    // Every wrap-up still nudges (plain reason) up to the bounded cap; the
    // suppressed retract never consumes an extra slot beyond the normal count.
    for (let i = 1; i <= CLEANUP_VERIFY_MAX_NUDGES; i++) {
      const r = await wrapUpWith(mw, op);
      expect(r).toMatchObject({ kind: "nudge", reason: "cleanup-verify" });
      expect(r.kind === "nudge" ? r.message : "").toContain(`${i}/${CLEANUP_VERIFY_MAX_NUDGES}`);
    }
    expect((await wrapUpWith(mw, op)).kind).toBe("continue");
  });
});

// ctx.userMessage is the session's FIRST user row, not the message that opened
// this op. Both hooks gate on "is THIS op a cleanup sweep?", so both must read
// the current request — in both directions.
describe("cleanup-verify — classifies the CURRENT request, not the session's opening line", () => {
  it("stays quiet at wrap-up when only the stale opening line was a cleanup", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const r = await cleanupVerifyMiddleware.afterModelCall!(
      ctxFor(op, {
        userMessage: CLEANUP_TASK,
        currentUserMessage: "What's the capital of France?",
        toolCalls: [],
        assistantContent: "Done — all tailnet references removed.",
      }),
    );
    expect(r.kind).toBe("continue");
    expect(opCleanupUnverified(op)).toBe(false);
  });

  it("nudges at wrap-up when the current request is a cleanup, whatever the opening line was", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const r = await cleanupVerifyMiddleware.afterModelCall!(
      ctxFor(op, {
        userMessage: "What's the capital of France?",
        currentUserMessage: CLEANUP_TASK,
        toolCalls: [],
        assistantContent: "Done — all tailnet references removed.",
      }),
    );
    expect(r.kind).toBe("nudge");
  });

  it("accrues grep evidence only for a CURRENT cleanup request", async () => {
    _resetMiddlewareStates();
    const op = opId();
    // Stale line is a cleanup, current is not: afterToolExecution must not
    // record the clean grep.
    await cleanupVerifyMiddleware.afterToolExecution!(
      ctxFor(op, {
        userMessage: CLEANUP_TASK,
        currentUserMessage: "What's the capital of France?",
        toolCalls: [{ toolCallId: "g1", tool: "grep", args: { pattern: "tailnet" } }],
        toolResults: [{ toolCallId: "g1", toolName: "grep", content: "", status: "ok" }],
      } as Partial<CanonicalLoopContext>),
    );
    // Now the CURRENT request is the cleanup and nothing was accrued → nudge.
    const r = await cleanupVerifyMiddleware.afterModelCall!(
      ctxFor(op, { currentUserMessage: CLEANUP_TASK, toolCalls: [], assistantContent: "Done — all tailnet references removed." }),
    );
    expect(r.kind).toBe("nudge");
  });
});

// Same 90%-misfire class as broad-sweep-nudge: CLEANUP_TASK-shaped prose is
// exactly what a dream brief or a build-chunk preamble composes, so the
// phrasing regex cannot separate it from a human's removal request — only op
// provenance can. BOTH hooks are gated: afterToolExecution must not accumulate
// evidence, and afterModelCall must neither nudge nor set the unverified
// verdict the terminal-outcome label reads.
describe("cleanup-verify — harness-authored task text is not a user request", () => {
  const DONE_CLAIM = "Done — all tailnet references removed.";
  const HARNESS_OP = { type: "memory_consolidation", lane: "background", taskProvenance: "harness" };

  function opCtx(
    op: string, opFields: Record<string, unknown>, over: Partial<CanonicalLoopContext> = {},
  ): CanonicalLoopContext {
    return makeCanonicalLoopContext({
      op: { id: op, ...opFields },
      turnIdx: 1,
      currentUserMessage: CLEANUP_TASK,
      assistantContent: "",
      toolCalls: [],
      toolResults: [],
      ...over,
    });
  }

  const dirtySearch = {
    toolCalls: [{ toolCallId: "g1", tool: "grep", args: { pattern: "tailnet" } }],
    toolResults: [{ toolCallId: "g1", toolName: "grep", content: "src/a.ts: tailnet", status: "ok" }],
  } as Partial<CanonicalLoopContext>;

  it("the cleanup text used below really does trip the regex — the gate, not the text, is what stops it", () => {
    expect(looksLikeCleanupSweep(CLEANUP_TASK)).toBe(true);
  });

  it("baseline: a user-authored op with this text still nudges and records unverified", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const userOp = { type: "chat_turn", lane: "interactive" };
    cleanupVerifyMiddleware.afterToolExecution!(opCtx(op, userOp, dirtySearch));
    const r = await cleanupVerifyMiddleware.afterModelCall!(
      opCtx(op, userOp, { assistantContent: DONE_CLAIM }),
    );
    expect(r).toMatchObject({ kind: "nudge" });
    expect(opCleanupUnverified(op)).toBe(true);
  });

  // afterToolExecution ALWAYS returns continue, so the return value alone
  // proves nothing — read the accumulated evidence instead. A gated harness op
  // must leave the state pristine: no search recorded, nothing outstanding.
  it("afterToolExecution records NO evidence on a provenance-stamped harness op (the memory_consolidation cluster)", () => {
    _resetMiddlewareStates();
    const op = opId();
    expect(cleanupVerifyMiddleware.afterToolExecution!(opCtx(op, HARNESS_OP, dirtySearch)))
      .toEqual({ kind: "continue" });
    const state = getMiddlewareState<CleanupVerifyState>(op, "cleanup-verify", createCleanupVerifyState);
    expect(state.searchedAny).toBe(false);
    expect(state.outstanding).toEqual([]);
  });

  it("afterToolExecution DOES record that same evidence on a user-authored op", () => {
    _resetMiddlewareStates();
    const op = opId();
    cleanupVerifyMiddleware.afterToolExecution!(
      opCtx(op, { type: "chat_turn", lane: "interactive" }, dirtySearch),
    );
    const state = getMiddlewareState<CleanupVerifyState>(op, "cleanup-verify", createCleanupVerifyState);
    expect(state.searchedAny).toBe(true);
    expect(state.outstanding).toEqual(["tailnet"]);
  });

  it("afterModelCall neither nudges nor records unverified on a harness op", async () => {
    _resetMiddlewareStates();
    const op = opId();
    cleanupVerifyMiddleware.afterToolExecution!(opCtx(op, HARNESS_OP, dirtySearch));
    const r = await cleanupVerifyMiddleware.afterModelCall!(
      opCtx(op, HARNESS_OP, { assistantContent: DONE_CLAIM }),
    );
    expect(r).toEqual({ kind: "continue" });
    expect(opCleanupUnverified(op)).toBe(false);
  });

  // op.type is MODEL-supplied and unvalidated (ops/tools/shared.ts:172); gating
  // on it would let a model switch BOTH hooks off by labelling its op. Only the
  // harness-written provenance stamp gates. Asserted through accumulated STATE
  // and the nudge, never through afterToolExecution's return value — that hook
  // always returns continue, so a bare toEqual({kind:"continue"}) proves nothing.
  it("STILL guards an unstamped op that merely CLAIMS type app_build — op.type is not a muzzle", async () => {
    _resetMiddlewareStates();
    const op = opId();
    const claimedBuild = { type: "app_build" };
    cleanupVerifyMiddleware.afterToolExecution!(opCtx(op, claimedBuild, dirtySearch));
    const state = getMiddlewareState<CleanupVerifyState>(op, "cleanup-verify", createCleanupVerifyState);
    expect(state.searchedAny).toBe(true);
    expect(state.outstanding).toEqual(["tailnet"]);
    const r = await cleanupVerifyMiddleware.afterModelCall!(
      opCtx(op, claimedBuild, { assistantContent: DONE_CLAIM }),
    );
    expect(r).toMatchObject({ kind: "nudge" });
    expect(opCleanupUnverified(op)).toBe(true);
  });
});
