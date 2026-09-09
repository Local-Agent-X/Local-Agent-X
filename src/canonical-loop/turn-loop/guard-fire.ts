/**
 * The guard fire counter — the ONE place `middleware_fired` is minted.
 *
 * The harness steers the model with ~30 behavioral guards (middlewares plus
 * completion gates) and, before this event, counted none of them:
 * canonical-events.jsonl carried 16 event types across 2,478 persisted ops and
 * not one was a guard firing, so a fire count could only be recovered by
 * string-matching nudge PROSE in op_messages — a record that rewording a nudge
 * silently destroys. Guards get retired on this evidence (2026-07-10), so an
 * uncounted path reads as a dead guard. Hence the exhaustive ledger below.
 *
 * COUNTED — a guard whose verdict took effect on the op. Each shape is the
 * body's `outcome` discriminator verbatim, so a fire count can be sliced by
 * WHAT the guard did and not merely by which guard did it:
 *   nudge            a middleware or completion-gate nudge that actually
 *                    reached op_messages (nudges.ts). One suppressed by
 *                    `stableMessageId` is a replay of an already-counted fire,
 *                    not a new one.
 *   abort            beforeTurn (nudges.ts middlewareAbortResult) AND
 *                    afterModelCall / afterToolExecution (apply-directive.ts) —
 *                    the second path is where loop-detection, repeat-output,
 *                    repeat-failure and thrash-guard actually end a turn. Both
 *                    count only when the abort's error bubble is really
 *                    emitted: emitErrorOnce collapses a repeat of the same
 *                    abort, and the count collapses with it.
 *   suspend          beforeTurn (suspension.ts) and the later phases plus the
 *                    idle-watchdog (apply-directive.ts). This is the autonomous
 *                    lane's pause — repeat-failure and thrash-guard suspend
 *                    instead of aborting on worker lanes, and nothing else
 *                    records it.
 *   rewrite          a guard that edits the model's tool call instead of
 *                    speaking (office-theme-guard strips an uninvited `theme`).
 *   honest-terminal  a completion gate that LETS the turn end but authors its
 *                    closing words (unresolved-tool-intent's second and later
 *                    fires). Not a nudge — nothing is appended for the model to
 *                    read — and not an abort: the turn stays `done`. The gate
 *                    NAMES this fire; decide-outcome.ts mints it at the
 *                    `appendHonestTerminal` call site and turn-loop.ts banks it
 *                    after commitTurn (bankEarnedFires below).
 *
 * NOT COUNTED — read a 0 with these in mind:
 *   - a `continue` verdict: a guard that looked and let the turn pass.
 *   - a completion gate that ACTS WITHOUT NUDGING: late-inject re-opening the
 *     turn, framework-serve registering a dev server. Counting those is a
 *     semantics expansion ("acted" vs "spoke") deliberately not made here.
 *   - build-verify's verifiedClean. NOT an "acts without nudging" case: it
 *     SPEAKS, pushing a user-facing assistant message (terminal-epilogue.ts
 *     `build-verify-ok-*`) in the same shape as the honest terminal. Counting
 *     it is no semantics expansion at all — it is the semantics already
 *     counted. It is uncounted only because nothing has wired it, and its
 *     append is guarded by `terminalReason !== null && !endedPartial &&
 *     buildVerifyConfirmation` — decided inside the epilogue, LATER than the
 *     gate chain — so it must contribute its fire at that append, not before.
 *   - render-verify's capReached, which is NOT the same hazard despite the
 *     resemblance. Its irreversible half already happened: the drained runtime
 *     errors are dropped and the retry counter is not even incremented on that
 *     branch (render-verify.ts), and a later reopen does not undo either. A
 *     fire for it would have to be minted where the drop happens; deferring it
 *     to a settled terminal would UNDER-count a real effect.
 *   - a directive discarded by a user cancel: driveTurn bails before the
 *     post-commit apply, so the verdict never reached the op.
 *   - THE OTHER FIVE HARNESS-AUTHORED TERMINALS. The harness writes its own
 *     closing assistant message in six places and counts ONE. Uncounted:
 *       `empty-turn-*`        empty-turn-termination.ts, a fully-empty
 *                             interactive turn
 *       `ask-user-*`          ask-user-terminal.ts, a trailing question made
 *                             the visible answer
 *       `open-steps-warn-*`   terminal-epilogue.ts, the loud-partial warning
 *       `build-verify-ok-*`   terminal-epilogue.ts, the green confirmation
 *       `ground-truth-sizes-* terminal-epilogue.ts, real file sizes over a
 *                             fabricated line count
 *     Only `empty-turn-*` shares the `appendHonestTerminal` writer with the
 *     gate's — that helper has exactly two call sites. The other four publish
 *     and push on their own, so a writer-based search finds neither them nor
 *     any future sibling. `outcome === "honest-terminal"` is therefore a census
 *     of ONE gate, not of harness-authored terminals — slice it as the former
 *     or five live code paths read as dead, the exact misreading this event
 *     exists to prevent.
 *
 * COUNTED BUT CONFLATED — one distinction the vocabulary does not draw:
 *   - a nudge that ALSO suppressed tool dispatch. loop-detection's
 *     mutation-repeat branch empties `ctx.toolCalls` and returns
 *     `skipToolDispatch: true`, so turn-loop.ts runs no tool at all; the model
 *     lost every call it made. It files as a plain `nudge` because
 *     `directiveFire` derives the outcome from `directive.kind`, which does not
 *     carry `skipToolDispatch` — while office-theme-guard deleting ONE argument
 *     gets its own `rewrite`. Deliberate: a suppressed dispatch is a modifier
 *     on a nudge verdict, not a different verdict, and no measured demand
 *     justifies a sixth shape or a second field. Named here because a silent
 *     conflation is precisely what this field exists to end.
 *
 * ROWS WITHOUT AN OUTCOME: `middleware_fired` shipped in e3e93aed and `outcome`
 * arrived a few commits later. Rows minted in between carry no `outcome` at
 * all, so they read `undefined` and a `group by outcome` drops them silently —
 * count them separately or bound the query below this commit.
 *
 * `turnIdx` is the turn the effect LANDS on, not the turn under judgment: a
 * next-turn nudge files under turnIdx + 1, an abort/suspend under the turn it
 * stopped, an honest terminal under the turn it ends.
 */
import { emit } from "../event-emitter.js";
import type { GuardOutcome, MiddlewareFiredBody } from "../types.js";
import type { MiddlewareDirective } from "./types.js";

/** The `{ name, reason, outcome }` half of MiddlewareFiredBody — the turnIdx
 *  half is supplied by whoever applies the fire. Required wherever a guard can
 *  speak, so a nudge cannot reach op_messages unnamed or unclassified.
 *
 *  `outcome` lives HERE, on the value every producer builds, rather than as an
 *  extra parameter to recordGuardFire. Several GuardFire literals never reach
 *  recordGuardFire directly — decide-outcome.ts's tool-failure summary,
 *  nudges.ts's recovered strategy pivot and adapter-throw-recovery.ts's resume
 *  nudge all hand theirs to appendNudgeAsUserMessage instead — so a parameter
 *  on recordGuardFire would leave exactly those producers silent, and a survey
 *  of them by hand would miss one. On the interface, an unstated outcome is a
 *  compile error at every producer and tsc enumerates them. */
export interface GuardFire {
  name: string;
  reason: string;
  outcome: GuardOutcome;
}

/** Persist one fire. The body shape lives here and nowhere else. */
export function recordGuardFire(opId: string, turnIdx: number, fire: GuardFire): void {
  const body: MiddlewareFiredBody = { name: fire.name, reason: fire.reason, outcome: fire.outcome, turnIdx };
  emit(opId, "middleware_fired", body);
}

/** Bank fires earned by effects that ACTUALLY LANDED on a now-durable turn.
 *  Called by turn-loop.ts after commitTurn, alongside applyCommittedDirective.
 *
 *  Two hazards make this the only correct place, and a gate can see neither
 *  from inside `evaluate`. A later gate's reopen discards the terminal an
 *  earlier gate authored. And every message decideTurnOutcome appends lives in
 *  an in-memory list until commitTurn writes it — with driveTurn's cancel bail
 *  sitting in between, precisely for "a Stop during its seconds–minutes verify
 *  gates". A fire recorded before that commit is a durable claim about a
 *  message a Stop can still erase, which is the same rule the NOT-COUNTED
 *  ledger already states for a directive discarded by a user cancel.
 *
 *  So gates NAME their fire beside the payload it belongs to
 *  (`CompletionGateOutput.honestTerminal`), the code that performs the effect
 *  contributes it to `DecideOutcomeResult.earnedFires`, and this banks the
 *  list once the turn is durable. The epilogue's verified-clean confirmation
 *  joins the same list at its own append when it is wired.
 *
 *  NO IDEMPOTENCY KEY: two decideTurnOutcome calls for one turnIdx would bank
 *  two identical bodies. Not reachable through worker.ts today, but note that
 *  `recoverCommittedStrategyPivot` earns its exactly-once through a
 *  `stableMessageId` and this has no equivalent. */
export function bankEarnedFires(opId: string, turnIdx: number, fires: readonly GuardFire[]): void {
  for (const fire of fires) recordGuardFire(opId, turnIdx, fire);
}

/** A sticky directive already carries its firer's name (turn-loop.ts stamps it)
 *  and its own kind, which IS the outcome — a nudge directive can only produce
 *  a nudge fire. Deriving it beats restating it: the three directive kinds and
 *  the first three outcomes are the same three verdicts. */
export function directiveFire(directive: MiddlewareDirective): GuardFire {
  return { name: directive.firedBy, reason: directive.reason, outcome: directive.kind };
}

/** A phase verdict straight off the middleware host. `firedBy` is always set on
 *  a non-`continue` result (middlewares/host.ts stamps `mw.name` on every one);
 *  the fallback exists ONLY because the type keeps the field optional for the
 *  `continue` case, and is not a reachable code path. */
export function firedResultFire(
  result: { kind: "nudge" | "abort" | "suspend"; firedBy?: string; reason: string },
): GuardFire {
  // `kind` is here to SUPPLY the outcome, not to close a hole: `continue` and
  // `retry-iteration` were already unable to reach this function, since neither
  // satisfies the required `reason: string`. Naming the three firing kinds
  // makes that pre-existing contract explicit and derivable.
  return { name: result.firedBy ?? "unknown", reason: result.reason, outcome: result.kind };
}
