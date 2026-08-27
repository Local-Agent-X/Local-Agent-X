// Tool dispatch for a turn. Hands the model's tool_call_requested list to the
// canonical tool-dispatcher boundary — as ONE dispatchBatch when the
// dispatcher supports it (so tool-execution's batcher can run parallel-safe
// calls concurrently), else per call in order — and captures the result rows
// for commitTurn. Cancellation between tools is honored so a long
// parallel-call group doesn't keep marching after the user cancels.
//
// Also the one place the committing verdict can be computed accurately: the
// summary row keeps argsHash, not args, so multi-action tools (pdf read vs
// pdf create) are indistinguishable downstream. isCommittingCall is asked
// here, while args are still in scope, and the answer rides the row.
//
// That same verdict feeds the SESSION TURN LOCK (session/turn-lock.ts), which
// has to know whether the user's live turn is mid-side-effect before letting a
// second message abort it. This is the only seam with all three inputs:
//   - the op id, so a DELEGATED background worker can be told apart from the
//     user's own chat turn. Workers inherit the originating chat session id
//     (ops/tools/shared.ts delegatedRuntimeSessionId), so keying on the session
//     alone would let a background op hold the user's chat lock for its life;
//   - the tool names, for the refusal message and session_status;
//   - the args, without which http_request / browser / pdf all read as
//     non-committing and the feature misses the case it exists for.
// Marks go in BEFORE dispatch (an in-flight charge must already be protected)
// and are settled against the result — but only a user-DECLINED call, refused
// by the approval gate before the tool body ever ran, is settled back down.
// See NEVER_LANDED for why every other status latches.

import { createHash } from "node:crypto";
import type { CanonicalMessageRole, ToolCallSummary, ToolDispatchStatus } from "../types.js";
import type { ToolCall } from "../contract-types.js";
import type { ToolDispatchResult } from "../tool-dispatch.js";
import type { CommitTurnMessage } from "../checkpoint.js";
import { emit } from "../event-emitter.js";
import { getToolDispatcher } from "../runtime.js";
import { isCommittingCall } from "../../committing-tool-check.js";
import { isInteractiveHostOpType, readOp } from "../../ops/op-store.js";
import { beginToolRound } from "../../session/turn-lock.js";

export interface DispatchedTools {
  toolMessages: CommitTurnMessage[];
  toolSummary: ToolCallSummary[];
}

/** Dispatch statuses that PROVE the call never reached its side effect. Exactly
 *  one qualifies: DECLINED, which only the approval gate produces and only
 *  strictly BEFORE the tool body runs (tool-execution/require-approval.ts and
 *  the two browser approval branches are its sole producers). Every other
 *  status may have landed, so it latches — committing-tool-check's rule holds:
 *  when in doubt, treat as committing.
 *
 *  Why `error` is NOT here, though it reads like failure: unlike `declined` it
 *  is decided DURING or AFTER the tool body, so it is the status most likely to
 *  mean "it landed and we don't know". result-helpers' err() is the generic
 *  failure return of dozens of tools: bash returns it on ANY non-zero exit, so
 *  a script that pushed a branch, published a package and then failed its last
 *  step is an `error`; email-send's catch wraps the transport send AND the
 *  bookkeeping after it, so a rejection once the server already accepted the
 *  mail is an `error`; and chat-tool-dispatcher maps ANY throw out of
 *  executeToolCalls to `error` — for the WHOLE batch, including calls that
 *  already completed.
 *
 *  Why `blocked` is NOT here either: it is not the pure pre-body policy verdict
 *  it looks like. Most producers are gates in tool-execution/, but several
 *  sites return it from inside the tool body — shell-tool blocks a command that
 *  already RAN and was killed mid-flight by antivirus, and browser-tools
 *  returns it from the catch wrapping the entire dispatch, which is reachable
 *  after a checkout click. The two flavors are indistinguishable HERE:
 *  ToolDispatchResult carries only status/result/durationMs, and the chat
 *  dispatcher recovers status by parsing the rendered header, which has already
 *  discarded the envelope metadata naming the layer. Re-deriving provenance by
 *  sniffing that text would be a heuristic over sites with no enforced
 *  convention, so the conservative branch is taken instead. The trade is the
 *  one the rule already prices in: a policy-blocked call makes the turn refuse
 *  a second user message until it ends — the user is told why and Stop still
 *  works — because missing an auto-failover is annoying and double-sending an
 *  email is worse. */
const NEVER_LANDED: ReadonlySet<ToolDispatchStatus> =
  new Set<ToolDispatchStatus>(["declined"]);

/** The chat session whose turn lock THIS op holds, or undefined for an op that
 *  holds none.
 *
 *  Only the interactive HOST op — the chat or voice turn the user is waiting on
 *  — owns a session turn lock. Delegated, cron, build and self-edit workers all
 *  inherit the originating chat session id (ops/tools/shared.ts
 *  delegatedRuntimeSessionId returns `originatingSessionId || opId`), so a
 *  background op that marked by session id alone would hold the user's chat
 *  lock for its whole life — refusing the user's next message to protect a turn
 *  that replacing would never have touched. `isInteractiveHostOpType` plus "no
 *  parentOpId" is the canonical predicate for "the op executing the user's
 *  turn"; turn-loop/record-outcome.ts keys the same distinction on it. */
function chatTurnSessionId(opId: string): string | undefined {
  const op = readOp(opId);
  if (!op || op.parentOpId || !isInteractiveHostOpType(op.type)) return undefined;
  return op.canonical?.sessionId || undefined;
}

export async function dispatchTools(
  opId: string,
  turnIdx: number,
  calls: ToolCall[],
  isCancelled?: () => boolean,
): Promise<DispatchedTools> {
  if (calls.length === 0) return { toolMessages: [], toolSummary: [] };
  const dispatcher = getToolDispatcher(opId);
  const lockSessionId = chatTurnSessionId(opId);
  const toolMessages: CommitTurnMessage[] = [];
  const toolSummary: ToolCallSummary[] = [];

  // Batch lane: when the dispatcher can take the whole list at once, hand it
  // over in ONE call so the underlying runtime (executeToolCalls) applies its
  // own parallel/serial batching — adjacent parallel-safe grouping, R4-09
  // gate-atomicity splits. Deciding WHAT runs concurrent stays there; this
  // loop only preserves the event vocabulary (tool_started per call before,
  // tool_finished per call after) and original call order. Cancellation is
  // checked once up front; in-flight cancellation propagates via the signal
  // the dispatcher already threads into executeToolCalls.
  if (dispatcher.dispatchBatch && calls.length > 1) {
    if (isCancelled?.()) return { toolMessages, toolSummary };
    const argsHashes = calls.map(c => hashArgs(c.args));
    const committing = calls.map(c => isCommittingCall(c.tool, c.args));
    calls.forEach((call, idx) =>
      emit(opId, "tool_started", { turnIdx, tool: call.tool, argsHash: argsHashes[idx] }));
    // The whole list goes to the dispatcher at once, so the whole list is in
    // flight at once — mark it all before the await, settle it all after.
    const round = beginToolRound(lockSessionId, calls.map((call, idx) =>
      ({ name: call.tool, committing: committing[idx] })));
    let outs: ToolDispatchResult[];
    try {
      // Contract (tool-dispatch.ts): results in input order, one per call.
      outs = await dispatcher.dispatchBatch(calls);
    } catch (e) {
      // The batch contract says this never throws, but a mark that outlives its
      // call would keep the turn off tryAcquireOrReplace's replaceable branch —
      // and off its force-release net — for the rest of the turn.
      round.abandon();
      throw e;
    }
    calls.forEach((call, idx) => {
      // The contract promises one result per call, but a SHORT array from a
      // non-conforming dispatcher would throw on `out.status` here — outside
      // the try above — and strand the rest of the round's marks. Synthesize
      // the missing row instead (same shape shapeCallResult uses for a call
      // that produced no result message), which settles it the conservative
      // way: an unknown outcome latches.
      const out: ToolDispatchResult = outs[idx] ?? {
        toolCallId: call.toolCallId,
        status: "error",
        result: { error: `dispatcher returned no result for tool '${call.tool}'` },
        durationMs: 0,
      };
      if (committing[idx]) round.settle(!NEVER_LANDED.has(out.status));
      emit(opId, "tool_finished", {
        turnIdx,
        tool: call.tool,
        status: out.status,
        durationMs: out.durationMs,
      });
      toolSummary.push({
        tool: call.tool,
        argsHash: argsHashes[idx],
        resultStatus: out.status,
        durationMs: out.durationMs,
        committing: committing[idx],
      });
      toolMessages.push({
        role: "tool_result",
        content: { toolCallId: call.toolCallId, result: out.result, status: out.status },
      });
    });
    return { toolMessages, toolSummary };
  }

  for (const call of calls) {
    // Bail before dispatching the next tool if the op was cancelled while a
    // previous tool in this batch was running. Without this, a parallel call
    // group like [self_edit, web_search, web_search, ...] keeps marching after
    // cancel — every subsequent tool fires its own abort error and the worker
    // never reaches the post-dispatch isCancelled check in driveTurn because
    // the for-loop never breaks. Empty toolMessages/toolSummary returned here
    // is fine: driveTurn sees the cancellation at the post-dispatch check
    // and returns cancelled=true without committing the partial turn.
    if (isCancelled?.()) break;
    const argsHash = hashArgs(call.args);
    const committing = isCommittingCall(call.tool, call.args);
    emit(opId, "tool_started", { turnIdx, tool: call.tool, argsHash });
    // Serial lane: exactly one call is in flight at a time, so its mark opens
    // and closes around its own await — a call the loop never reaches (cancel
    // above) is never marked.
    const round = beginToolRound(lockSessionId, [{ name: call.tool, committing }]);
    let out: ToolDispatchResult;
    try {
      out = await dispatcher.dispatch(call);
      round.settle(!NEVER_LANDED.has(out.status));
    } finally {
      round.abandon(); // no-op once settle() has accounted for the call
    }
    emit(opId, "tool_finished", {
      turnIdx,
      tool: call.tool,
      status: out.status,
      durationMs: out.durationMs,
    });
    toolSummary.push({
      tool: call.tool,
      argsHash,
      resultStatus: out.status,
      durationMs: out.durationMs,
      committing,
    });
    const role: CanonicalMessageRole = "tool_result";
    toolMessages.push({
      role,
      content: { toolCallId: call.toolCallId, result: out.result, status: out.status },
    });
  }
  return { toolMessages, toolSummary };
}

function hashArgs(args: unknown): string {
  try {
    return createHash("sha256").update(JSON.stringify(args ?? null)).digest("hex").slice(0, 16);
  } catch {
    return "0000000000000000";
  }
}
