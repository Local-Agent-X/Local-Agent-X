/**
 * Post-turn detector stack — wraps runPostTurnDetectors from
 * agent-loop-detectors.ts. Catches planning-only turns, single-action-stop,
 * evidence-stale, uncommitted turns, etc. Canonical-loop port of
 * src/agent-loop/middlewares/post-turn-detector.ts.
 *
 * Legacy stuffs the hit into `ctx.promptLayers.retry` so the next iteration's
 * system prompt carries the nudge, and returns retry-iteration. Canonical
 * has no prompt-layer surface today; for parity we push the instruction as
 * a user message via the standard `nudge` directive — same effective
 * behavior (model sees the nudge on the next turn), just plumbed through
 * op_messages instead of a layer.
 */
import { isWorkerOp, type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";

const RETRY_COUNTERS_KEY = "post-turn-detector-counters";

/**
 * True when the most recent genuine user turn carried an image attachment.
 *
 * Canonical op_messages store a user image as a `{ text, images: [...] }`
 * envelope (see turn-loop/build-input.ts:hasImages and
 * chat-tool-dispatcher.ts) — NOT the OpenAI multi-part `image_url` array
 * that agent-loop-detectors' `userMessageHasImages()` probes for. That
 * helper checks `Array.isArray(content)` and so always returns false against
 * canonical rows, leaving the detector stack's `skipOnImages` exemption dead:
 * a worker replying "I see X, try Y" to a screenshot reads as a stalled plan
 * and triggers the planning-only nudge storm. We detect the real envelope
 * here instead. Synthetic nudges are also `role:"user"` rows
 * (`content.kind === "nudge"`) but are engine-injected, not a fresh user
 * turn, so they don't reset the "is the model replying to an image" signal.
 */
function latestUserTurnHasImages(rows: Array<{ role: string; content: unknown }>): boolean {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role !== "user") continue;
    const c = r.content as { kind?: unknown; images?: unknown } | null | undefined;
    if (c?.kind === "nudge") continue;
    return Array.isArray(c?.images) && (c.images as unknown[]).length > 0;
  }
  return false;
}

export const postTurnDetectorMiddleware: CanonicalMiddleware = {
  name: "post-turn-detector",

  // Worker-only: the commit/act/blocker nudges leak into interactive replies
  // (and get spoken in voice). See isWorkerOp.
  when: isWorkerOp,

  async afterModelCall(ctx) {
    const { runPostTurnDetectors, computeEvidenceCount, createRetryCounters, countEnumeratedSteps } =
      await import("../../agent-loop-detectors/index.js");
    const counters = getMiddlewareState(ctx.op.id, RETRY_COUNTERS_KEY, createRetryCounters);

    // Compute evidence from the committed op_messages PLUS this turn's
    // just-emitted assistant tool calls (those haven't been committed yet
    // — afterModelCall fires before commitTurn). Build a thin
    // ChatCompletionMessageParam[] view because computeEvidenceCount reads
    // assistant.tool_calls from that exact shape.
    const { readOpMessages } = await import("../store.js");
    const { extractText } = await import("../turn-loop/content-extract.js");
    const rows = readOpMessages(ctx.op.id);

    // Highest enumerated step count across the op's genuine user instructions.
    // Injected nudges are also user rows but carry no "1) 2) 3)" enumeration,
    // so taking the max keeps the original request's step count intact.
    let enumeratedSteps = 0;
    for (const r of rows) {
      if (r.role !== "user") continue;
      enumeratedSteps = Math.max(enumeratedSteps, countEnumeratedSteps(extractText(r.content)));
    }
    const messagesView = rows.map(r => {
      if (r.role !== "assistant") {
        return { role: r.role === "tool_result" ? "tool" : r.role, content: "" } as { role: string; content: unknown };
      }
      const toolCalls = (r.content as { toolCalls?: Array<{ id?: string; name: string; arguments?: string }> })?.toolCalls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        return {
          role: "assistant",
          content: "",
          tool_calls: toolCalls.map(tc => ({
            id: tc.id ?? "",
            type: "function",
            function: { name: tc.name, arguments: tc.arguments ?? "" },
          })),
        };
      }
      return { role: "assistant", content: "" };
    }) as Array<{ role: string; content: unknown; tool_calls?: Array<{ function?: { name?: string } }> }>;

    // Append this turn's tool calls so evidence count includes them.
    if (ctx.toolCalls.length > 0) {
      messagesView.push({
        role: "assistant",
        content: "",
        tool_calls: ctx.toolCalls.map(tc => ({
          function: { name: tc.tool },
        })),
      });
    }

    ctx.evidenceHistory.push(
      computeEvidenceCount(messagesView as unknown as Parameters<typeof computeEvidenceCount>[0]),
    );

    const detectorState = {
      assistantText: ctx.assistantContent,
      toolCallsThisIteration: ctx.toolCalls.map(tc => ({
        name: tc.tool,
        arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? null),
      })),
      toolsCalledThisTurn: ctx.toolsCalledThisOp,
      // The two commit verdicts the host already computed, in the SAME
      // op_turns walk that builds toolsCalledThisOp (middlewares/types.ts), so
      // the detectors that consume them no longer re-run isCommittingTool over
      // the set whose filtered forms are already sitting in ctx.
      //
      // Both projections are read because the detectors do NOT ask one
      // question, and neither projection is a subset of the other:
      //   - SUBSTANTIVE (arg-aware, task_* ledger EXCLUDED) answers "did the
      //     model do the USER'S work, as opposed to planning?" — a `pdf create`
      //     or a `browser` submit counts where the name-only check sees
      //     nothing, and a turn that only wrote its own plan still reads as
      //     uncommitted. That is detectPlanningOnly's question, and only its.
      //   - Their UNION answers "is there ANY committed side effect on record
      //     for this op?" — detectUncommittedTurn's and detectEvidenceStale's
      //     question. See the call-site comments in
      //     agent-loop-detectors/detectors.ts.
      //
      // Why the union rather than either set alone — each one is blind exactly
      // where the other sees, so OR is strictly better than picking one:
      //   - RAW alone (name-only isCommittingTool) answers false for all three
      //     ARG_AWARE_TOOLS, so an op whose only work was a `pdf create`, a
      //     `browser` submit or an `http_request` POST reads as having
      //     committed nothing and gets told to "call the tool that actually
      //     commits work" — after doing exactly that.
      //   - SUBSTANTIVE alone drops the task_* ledger, so a read-only research
      //     op is 0 by definition once open-steps has seeded its task list on
      //     turn 0, and both detectors would demand a commit the user never
      //     asked for.
      // The union keeps RAW's read-only stand-down verbatim — `a || b` can
      // never be false where `a` was true, so no stand-down the raw tally used
      // to give is lost — and adds the three arg-aware tools it was blind to.
      // A registry-wide probe over all 197 tools confirms those three
      // (`browser`, `http_request`, `pdf`) are the ONLY names on which the two
      // projections diverge in that direction; every other tool is decided
      // identically by both, so the union changes nothing else.
      //
      // WHAT THE UNION IS — stated plainly, because the comment that used to
      // sit here denied it. `raw.size > 0 || substantive.size > 0` is not a
      // near-miss for the repo's canonical "did this op commit anything?"
      // predicate; it IS that predicate. It equals
      // `opCommittedWork(readOpTurns(op.id))` exactly — arg-aware, task_*
      // ledger included — for every row dispatch can write. Probed over the
      // whole registry: 197 tools x 4 resultStatus values x 16 rows per pair
      // (15 arg shapes each stamped through isCommittingCall, the way dispatch
      // stamps them, plus the legacy absent-field row) = 12,608 single-row
      // cases, zero disagreements. Multi-row follows, since all three
      // quantities are ORs over the same rows. The contract test re-runs this
      // sweep de-duplicated. The one shape that WOULD break it —
      // `committing:false` stamped on a name-committing tool — is unreachable:
      // dispatch-tools.ts is the sole writer of that field and writes
      // isCommittingCall(tool, args), which never answers false where
      // isCommittingTool answers true.
      //
      // So this call site deliberately re-derives opCommittedWork's semantics
      // from the two tallies host.ts already holds. Both direct routes are
      // closed on purpose:
      //   - Calling opCommittedWork(readOpTurns(op.id)) here adds a FOURTH
      //     op_turns walk per turn on top of the three buildCanonicalLoopContext
      //     already does (host.ts, "why a middleware holding a ctx must read
      //     these").
      //   - Adding a third ctx Set is what host.ts forbids in as many words:
      //     the last "abort-safety" projection shipped, was read by exactly one
      //     site, and was reverted there.
      // The cost of an inline re-derivation is silent drift, so
      // committed-work-union-contract.test.ts pins this expression to
      // opCommittedWork over the same rows. If you change how host.ts builds
      // either tally, that test is what tells you the union stopped being the
      // canonical predicate.
      //
      // WHY IT IS CORRECT HERE though mid-turn-stale rejected the same
      // predicate: different consumer, opposite direction of failure. Both
      // detectors that read this use it to STAND DOWN (`if (committed) return
      // null`), so an over-generous "committed" costs at most one nudge the
      // model never sees. mid-turn-stale used it to skip an abort BRAKE, so an
      // over-generous "committed" left a spinning interactive turn with no
      // circuit breaker — measured there as a left-nav "Purchase Orders" click
      // disarming it from turn 3. Over-matching is cheap on this side of the
      // seam and unsafe on that one; that asymmetry, not the predicate, is what
      // decides which tally a reader takes. The noise this tolerance is
      // absorbing is measured at the consumer call sites in
      // agent-loop-detectors/detectors.ts.
      committedSubstantiveWork: ctx.substantiveCommittingToolsThisOp.size > 0,
      committedWorkOrLedger:
        ctx.committingToolsThisOp.size > 0 || ctx.substantiveCommittingToolsThisOp.size > 0,
      // Real per-turn signals threaded by turn-loop (HE-5). Hardcoding
      // false/0 here made detectReasoningOnly unreachable: a turn that
      // burned reasoning tokens and stopped got "produced no visible reply"
      // (empty-response) instead of "continue from partial state, do not
      // restart" — inviting the from-scratch restart the reasoning
      // instruction exists to prevent. Absent (older callers) degrades to
      // the previous behavior.
      hasReasoning: ctx.hasReasoning ?? false,
      completionTokens: ctx.completionTokens ?? 0,
      iteration: ctx.turnIdx,
      evidenceCount: ctx.evidenceHistory[ctx.evidenceHistory.length - 1],
      evidenceHistory: [...ctx.evidenceHistory],
      // Detect images off the REAL op_messages rows (canonical `{images:[]}`
      // envelope), not the content-stripped messagesView above — that view
      // zeroes every non-assistant row's content, which silently killed the
      // detector stack's skipOnImages vision exemption.
      userMessageHasImages: latestUserTurnHasImages(rows),
      enumeratedSteps,
    };

    const hit = runPostTurnDetectors(detectorState, counters);
    if (hit) {
      return { kind: "nudge", message: hit.instruction, reason: `post-turn:${hit.kind}` };
    }
    return { kind: "continue" };
  },
};
