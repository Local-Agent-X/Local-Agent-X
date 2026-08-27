// Regression for "the turn lock's committing-turn refusal was silently inert".
//
// The registry's `hasCommitted` had no production writer, so
// tryAcquireOrReplace could never return "refused-committing": a second user
// message aborted an in-flight turn even one that was mid-payment, and
// session_status reported "has made a committing tool call: no" for every turn,
// always.
//
// dispatchTools is the seam that fixes it, and each of the three things it
// holds closes a defect a shallower seam left open:
//
//   1. THE OP ID → chat vs delegated. Delegated/cron/build workers inherit the
//      originating chat session id (ops/tools/shared.ts
//      delegatedRuntimeSessionId), so marking by session id alone lets a
//      BACKGROUND op hold the user's chat lock for its whole life — refusing
//      the user's next message to protect a turn replacing would never have
//      touched.
//   2. THE RESULT → the approval decline happens inside tool execution.
//      Marking before the tools run is right (an in-flight charge must already
//      be protected), but the mark has to be settled against the outcome, or a
//      DECLINED call latches a session that did nothing — with no reset path
//      and no force-release net, because that net lives only on
//      tryAcquireOrReplace's non-committing branch. Settling is one-directional
//      on purpose: `declined` is the ONLY status decided before the tool body,
//      so it is the only one that unlatches. See NEVER_LANDED in
//      dispatch-tools.ts for why `error` and `blocked` do not.
//   3. THE ARGS → isCommittingTool answers FALSE for http_request / browser /
//      pdf. A name-only verdict leaves an in-flight charge POST replaceable,
//      which is the exact case the feature exists for.

import { describe, it, expect, afterAll, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { dispatchTools } from "./dispatch-tools.js";
import {
  registerToolDispatcherForOp,
  unregisterToolDispatcherForOp,
} from "../runtime.js";
import {
  functionToolDispatcher,
  type ToolDispatcher,
  type ToolDispatchResult,
} from "../tool-dispatch.js";
import { writeOp } from "../../ops/op-store.js";
import { isCommittingCall, isCommittingTool } from "../../committing-tool-check.js";
import {
  getTurnRegistry,
  getActiveTurn,
  releaseTurn,
  tryAcquireOrReplace,
} from "../../session/turn-lock.js";
import type { ToolCall } from "../contract-types.js";
import type { ToolDispatchStatus } from "../types.js";
import type { Op } from "../../ops/types.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const registry = getTurnRegistry();
const trackedOpIds: string[] = [];
const trackedSessions: string[] = [];
let seq = 0;

function freshOpId(): string { return `op_dispatch_lock_test_${seq++}_${process.pid}`; }

/** Persist the minimum operation.json dispatchTools reads back to decide
 *  whether this op owns the session's turn lock. */
function makeOp(type: string, sessionId: string, parentOpId?: string): string {
  const id = freshOpId();
  trackedOpIds.push(id);
  writeOp({
    id,
    type,
    status: "running",
    createdAt: new Date().toISOString(),
    attemptCount: 0,
    ...(parentOpId ? { parentOpId } : {}),
    canonical: { flagValue: true, state: "running", sessionId },
  } as unknown as Op);
  return id;
}

function session(label: string): string {
  const id = `s-dispatch-lock-${label}-${process.pid}`;
  trackedSessions.push(id);
  return id;
}

function call(toolCallId: string, tool: string, args: unknown = {}): ToolCall {
  return { toolCallId, tool, args };
}

/** Single-call dispatcher with a programmable status and an optional hook that
 *  runs WHILE the call is in flight — the window the lock has to protect. */
function statusDispatcher(status: ToolDispatchStatus, onRun?: () => void): ToolDispatcher {
  return functionToolDispatcher(async (c) => {
    onRun?.();
    return { status, result: `ran:${c.tool}` };
  });
}

/** Batch dispatcher: per-tool statuses, one result per call, input order. */
function batchDispatcher(statusFor: (tool: string) => ToolDispatchStatus): ToolDispatcher {
  const one = (c: ToolCall): ToolDispatchResult =>
    ({ toolCallId: c.toolCallId, status: statusFor(c.tool), result: `ran:${c.tool}`, durationMs: 1 });
  return {
    async dispatch(c) { return one(c); },
    async dispatchBatch(cs: ToolCall[]) { return cs.map(one); },
  };
}

afterEach(() => {
  for (const id of trackedOpIds) unregisterToolDispatcherForOp(id);
  for (const s of trackedSessions) releaseTurn(s);
});

afterAll(() => {
  for (const id of trackedOpIds) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

describe("dispatchTools feeds the session turn lock", () => {
  it("an in-flight http_request POST makes the turn REFUSE replacement", async () => {
    // Fixture guard for defect 3: the name-only verdict the inert version used
    // says false here, so a name-only mark leaves the charge replaceable.
    expect(isCommittingTool("http_request")).toBe(false);
    expect(isCommittingCall("http_request", { method: "POST", url: "https://api.stripe.test/v1/charges" }))
      .toBe(true);

    const SESSION = session("post");
    const opId = makeOp("chat_turn", SESSION);
    const priorAc = new AbortController();
    expect(registry.acquireTurn(SESSION, priorAc, "prior")).toBe(true);
    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(false);

    // Read the flag from INSIDE the call: the charge is in flight at this
    // instant, so the turn must already be un-replaceable.
    let committedWhileRunning: boolean | undefined;
    registerToolDispatcherForOp(opId, statusDispatcher("ok", () => {
      committedWhileRunning = getActiveTurn(SESSION)?.hasCommitted;
    }));

    await dispatchTools(opId, 0, [
      call("c-1", "http_request", { method: "POST", url: "https://api.stripe.test/v1/charges" }),
    ]);

    expect(committedWhileRunning).toBe(true);

    const snapshot = getActiveTurn(SESSION)!;
    expect(snapshot.hasCommitted).toBe(true);
    expect(snapshot.iteration).toBe(1);
    expect(snapshot.toolsCalled).toEqual(["http_request"]);
    expect(snapshot.lastToolName).toBe("http_request");

    const newAc = new AbortController();
    const decision = await tryAcquireOrReplace(SESSION, newAc, "second-message");

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("refused-committing");
    // The committing turn is left alone; the new controller took nothing.
    expect(priorAc.signal.aborted).toBe(false);
    expect(newAc.signal.aborted).toBe(false);
  });

  it("an idempotent http_request GET stays replaceable", async () => {
    const SESSION = session("get");
    const opId = makeOp("chat_turn", SESSION);
    const priorAc = new AbortController();
    expect(registry.acquireTurn(SESSION, priorAc, "prior")).toBe(true);
    registerToolDispatcherForOp(opId, statusDispatcher("ok"));

    await dispatchTools(opId, 0, [
      call("c-1", "http_request", { method: "GET", url: "https://example.test/status" }),
    ]);

    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(false);
    expect(getActiveTurn(SESSION)?.lastToolName).toBe("http_request");

    const decisionPromise = tryAcquireOrReplace(SESSION, new AbortController(), "second-message");
    expect(priorAc.signal.aborted).toBe(true);
    releaseTurn(SESSION); // stand in for the aborted handler finishing its commit
    const decision = await decisionPromise;
    expect(decision.reason).toBe("aborted-non-committing");
  });

  it("a BLOCKED committing tool stays latched — `blocked` is not proof the body never ran", async () => {
    expect(isCommittingTool("bash")).toBe(true);

    const SESSION = session("blocked");
    const opId = makeOp("chat_turn", SESSION);
    const priorAc = new AbortController();
    expect(registry.acquireTurn(SESSION, priorAc, "prior")).toBe(true);

    let committedWhileRunning: boolean | undefined;
    registerToolDispatcherForOp(opId, statusDispatcher("blocked", () => {
      committedWhileRunning = getActiveTurn(SESSION)?.hasCommitted;
    }));

    const out = await dispatchTools(opId, 0, [call("c-1", "bash", { command: "rm -rf /" })]);
    expect(out.toolSummary[0].resultStatus).toBe("blocked");

    // Marking optimistically is right — the verdict is only known inside
    // execution, so the window is protected while it is unknown.
    expect(committedWhileRunning).toBe(true);
    // ...and it STAYS protected. Most `blocked` results are pre-body policy
    // gates, but several tools return blocked from inside their own body (a
    // shell command AV-killed mid-run, a browser catch that wraps the whole
    // dispatch), and nothing on ToolDispatchResult tells the two apart at this
    // seam. Conservative branch: it may have landed, so it latches.
    const snapshot = getActiveTurn(SESSION)!;
    expect(snapshot.hasCommitted).toBe(true);
    expect(snapshot.toolsCalled).toEqual(["bash"]);

    const decision = await tryAcquireOrReplace(SESSION, new AbortController(), "second-message");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("refused-committing");
    expect(priorAc.signal.aborted).toBe(false);
  });

  it("a DECLINED committing tool does not latch either", async () => {
    const SESSION = session("declined");
    const opId = makeOp("chat_turn", SESSION);
    expect(registry.acquireTurn(SESSION, new AbortController(), "prior")).toBe(true);
    registerToolDispatcherForOp(opId, statusDispatcher("declined"));

    await dispatchTools(opId, 0, [call("c-1", "bash", { command: "echo hi" })]);

    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(false);
  });

  it("an ERRORED committing tool stays latched — error is decided during or after the body", async () => {
    // The defect this pins: `error` was read as "the tool reported the work
    // failed" and settled the mark back down. It is the opposite — err() is the
    // generic failure return, so an email_send that reached the transport and
    // then threw (or whose bookkeeping after the send threw) comes back
    // `error` with the mail already delivered. Settling that down let the next
    // user message abort and REPLACE the turn, and the replacement re-sends.
    expect(isCommittingTool("email_send")).toBe(true);

    const SESSION = session("error");
    const opId = makeOp("chat_turn", SESSION);
    const priorAc = new AbortController();
    expect(registry.acquireTurn(SESSION, priorAc, "prior")).toBe(true);
    registerToolDispatcherForOp(opId, statusDispatcher("error"));

    const out = await dispatchTools(opId, 0, [
      call("c-1", "email_send", { to: "a@b.test", subject: "invoice", body: "..." }),
    ]);
    expect(out.toolSummary[0].resultStatus).toBe("error");
    expect(out.toolSummary[0].committing).toBe(true);

    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(true);

    const decision = await tryAcquireOrReplace(SESSION, new AbortController(), "second-message");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("refused-committing");
    // The turn that already sent the mail is left alone, so nothing re-sends.
    expect(priorAc.signal.aborted).toBe(false);
  });

  it("the batch lane latches when its catch maps the whole round to error", async () => {
    // chat-tool-dispatcher's dispatchBatch catch maps EVERY call in the batch
    // to `error` on any throw out of executeToolCalls — including calls that
    // already ran to completion. So a batch-wide error must latch too.
    const SESSION = session("batch-error");
    const opId = makeOp("chat_turn", SESSION);
    const priorAc = new AbortController();
    expect(registry.acquireTurn(SESSION, priorAc, "prior")).toBe(true);
    registerToolDispatcherForOp(opId, batchDispatcher(() => "error"));

    await dispatchTools(opId, 0, [
      call("c-1", "read", { file_path: "a.txt" }),
      call("c-2", "email_send", { to: "a@b.test", subject: "invoice", body: "..." }),
    ]);

    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(true);

    const decision = await tryAcquireOrReplace(SESSION, new AbortController(), "second-message");
    expect(decision.reason).toBe("refused-committing");
    expect(priorAc.signal.aborted).toBe(false);
  });

  it("a batch dispatcher returning a SHORT result array strands no mark", async () => {
    // The settle loop sits outside the try/catch, so an unguarded out.status on
    // a missing row would throw past round.abandon(). The missing row is
    // synthesized as `error` instead — which latches, the conservative read of
    // an unknown outcome.
    const SESSION = session("short-batch");
    const opId = makeOp("chat_turn", SESSION);
    expect(registry.acquireTurn(SESSION, new AbortController(), "prior")).toBe(true);
    registerToolDispatcherForOp(opId, {
      async dispatch(c) { return { toolCallId: c.toolCallId, status: "ok", result: "", durationMs: 1 }; },
      async dispatchBatch(cs: ToolCall[]) {
        return [{ toolCallId: cs[0].toolCallId, status: "ok" as const, result: "ran", durationMs: 1 }];
      },
    });

    const out = await dispatchTools(opId, 0, [
      call("c-1", "read", { file_path: "a.txt" }),
      call("c-2", "email_send", { to: "a@b.test", subject: "invoice", body: "..." }),
    ]);

    // Every call still gets a summary row and a tool_result message — the loop
    // completed instead of throwing partway and leaving the round open.
    expect(out.toolSummary.map(s => s.resultStatus)).toEqual(["ok", "error"]);
    expect(out.toolMessages).toHaveLength(2);
    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(true);
  });

  it("a TIMED OUT committing tool stays latched — the work may have landed", async () => {
    const SESSION = session("timeout");
    const opId = makeOp("chat_turn", SESSION);
    expect(registry.acquireTurn(SESSION, new AbortController(), "prior")).toBe(true);
    registerToolDispatcherForOp(opId, statusDispatcher("timeout"));

    await dispatchTools(opId, 0, [
      call("c-1", "http_request", { method: "POST", url: "https://api.stripe.test/v1/charges" }),
    ]);

    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(true);
  });

  it("a DELEGATED background op never marks the chat session it inherited", async () => {
    // delegatedRuntimeSessionId(opId, sessionId) returns the ORIGINATING chat
    // session for any op submitted from a chat turn, and that id is what the
    // worker's runtime is built with. So the background op below carries the
    // user's session id verbatim — the exact shape that poisoned innocent turns.
    const SESSION = session("delegated");
    const workerOpId = makeOp("freeform", SESSION);
    const priorAc = new AbortController();
    expect(registry.acquireTurn(SESSION, priorAc, "innocent-chat-turn")).toBe(true);

    registerToolDispatcherForOp(workerOpId, statusDispatcher("ok"));
    const out = await dispatchTools(workerOpId, 0, [call("c-1", "bash", { command: "npm test" })]);

    // The worker's own bookkeeping is unaffected...
    expect(out.toolSummary[0].committing).toBe(true);
    // ...but the user's chat turn ran zero tools and must still look like it.
    const snapshot = getActiveTurn(SESSION)!;
    expect(snapshot.hasCommitted).toBe(false);
    expect(snapshot.toolsCalled).toEqual([]);
    expect(snapshot.iteration).toBe(0);

    const decisionPromise = tryAcquireOrReplace(SESSION, new AbortController(), "second-message");
    expect(priorAc.signal.aborted).toBe(true);
    releaseTurn(SESSION);
    expect((await decisionPromise).reason).toBe("aborted-non-committing");
  });

  it("a spawned op that calls itself chat_turn is still not the host turn", async () => {
    const SESSION = session("spawned");
    const spawnedOpId = makeOp("chat_turn", SESSION, "op_parent_of_the_spawn");
    expect(registry.acquireTurn(SESSION, new AbortController(), "innocent-chat-turn")).toBe(true);
    registerToolDispatcherForOp(spawnedOpId, statusDispatcher("ok"));

    await dispatchTools(spawnedOpId, 0, [call("c-1", "bash", { command: "echo hi" })]);

    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(false);
    expect(getActiveTurn(SESSION)?.toolsCalled).toEqual([]);
  });

  it("an op with no session at all marks nothing and does not throw", async () => {
    const opId = makeOp("chat_turn", "");
    registerToolDispatcherForOp(opId, statusDispatcher("ok"));
    const out = await dispatchTools(opId, 0, [call("c-1", "bash", { command: "echo hi" })]);
    expect(out.toolSummary[0].resultStatus).toBe("ok");
  });

  it("the batch lane settles each call in the round against its own status", async () => {
    const SESSION = session("batch-declined");
    const opId = makeOp("chat_turn", SESSION);
    expect(registry.acquireTurn(SESSION, new AbortController(), "prior")).toBe(true);
    // `declined` on the one committing call in the round: the only status that
    // proves the body never ran, so the round settles back to un-latched even
    // though its siblings succeeded.
    registerToolDispatcherForOp(opId, batchDispatcher(t => (t === "bash" ? "declined" : "ok")));

    await dispatchTools(opId, 0, [
      call("c-1", "read", { file_path: "a.txt" }),
      call("c-2", "bash", { command: "rm -rf /" }),
      call("c-3", "pdf", { action: "read", file_path: "a.pdf" }),
    ]);

    const snapshot = getActiveTurn(SESSION)!;
    expect(snapshot.hasCommitted).toBe(false);
    expect(snapshot.toolsCalled).toEqual(["read", "bash", "pdf"]);
    // One dispatch round is one iteration, however many calls it held.
    expect(snapshot.iteration).toBe(1);
  });

  it("the batch lane latches when a committing call in the round succeeds", async () => {
    const SESSION = session("batch-ok");
    const opId = makeOp("chat_turn", SESSION);
    expect(registry.acquireTurn(SESSION, new AbortController(), "prior")).toBe(true);
    registerToolDispatcherForOp(opId, batchDispatcher(() => "ok"));

    // pdf create is committing, pdf read is not — the distinction only the
    // arg-aware verdict can make, on the lane that runs them together.
    await dispatchTools(opId, 0, [
      call("c-1", "pdf", { action: "read", file_path: "a.pdf" }),
      call("c-2", "pdf", { action: "create", file_path: "b.pdf" }),
    ]);

    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(true);

    const decision = await tryAcquireOrReplace(SESSION, new AbortController(), "second-message");
    expect(decision.reason).toBe("refused-committing");
  });

  it("a dispatcher that THROWS mid-batch leaves no stranded mark", async () => {
    const SESSION = session("throwing");
    const opId = makeOp("chat_turn", SESSION);
    const priorAc = new AbortController();
    expect(registry.acquireTurn(SESSION, priorAc, "prior")).toBe(true);
    registerToolDispatcherForOp(opId, {
      async dispatch() { throw new Error("dispatcher exploded"); },
      async dispatchBatch() { throw new Error("dispatcher exploded"); },
    });

    await expect(dispatchTools(opId, 0, [
      call("c-1", "bash", { command: "echo hi" }),
      call("c-2", "bash", { command: "echo there" }),
    ])).rejects.toThrow("dispatcher exploded");

    // An unsettled mark would keep the turn off the replaceable branch — and so
    // off its force-release net — for the rest of the turn.
    expect(getActiveTurn(SESSION)?.hasCommitted).toBe(false);

    const decisionPromise = tryAcquireOrReplace(SESSION, new AbortController(), "second-message");
    expect(priorAc.signal.aborted).toBe(true);
    releaseTurn(SESSION);
    expect((await decisionPromise).reason).toBe("aborted-non-committing");
  });
});
