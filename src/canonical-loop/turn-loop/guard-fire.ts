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
 *                    closing words. Not a nudge — nothing is appended for the
 *                    model to read — and not an abort: the turn stays `done`.
 *                    TWO producers, both on the earned-fire seam because both
 *                    appends stay contingent after the gate returns:
 *                    unresolved-tool-intent's second and later fires (the gate
 *                    NAMES the fire, decide-outcome.ts mints it at the
 *                    `appendHonestTerminal` call site, a later gate's reopen
 *                    discards both together) and build-verify's verifiedClean
 *                    confirmation (terminal-epilogue.ts pushes
 *                    `build-verify-ok-*` and contributes the fire inside the
 *                    same `!endedPartial` branch, so a partial-ending op that
 *                    suppresses the message banks nothing). turn-loop.ts banks
 *                    both after commitTurn (bankEarnedFires below). Slice by
 *                    `name` for one gate — see the terminal caveat below.
 *   reopen           the turn's terminal was VETOED and another turn driven
 *                    WITHOUT saying anything: a user follow-up that landed
 *                    mid-turn, which drainInjectsIntoTurn pulls in next.
 *                    late-inject's SEVEN re-opening gate siblings all speak, so
 *                    they file as `nudge` — the message is the effect that
 *                    lands, and the reopen is only how it gets read. (Seven:
 *                    COMPLETION_GATES holds nine, framework-serve never
 *                    re-opens, and late-inject is the subject.)
 *                    TWO PRODUCERS, one per arrival window, and a census of
 *                    "a follow-up vetoed a terminal" must SUM them:
 *                      continuation-guard / injects-pending — decide-outcome.ts
 *                        (CONTINUATION_INJECT_FIRE below). The inject was
 *                        ALREADY queued when decideTurnOutcome ran, so the
 *                        guard re-opens before the chain and lateInjectGate
 *                        never evaluates.
 *                      late-inject / late-inject — decide-outcome-gates.ts. It
 *                        landed DURING the async verify gates, each of which
 *                        awaits.
 *                    Mutually exclusive, and deliberately NOT one name: a
 *                    `late-inject` row for a run where that gate never
 *                    evaluated would be a false provenance claim.
 *                    BOTH ride the earned-fire seam (bankEarnedFires below).
 *                    The veto's entire effect is an in-memory
 *                    `terminalReason = null` on its way to a commitTurn a Stop
 *                    can cancel — unlike `repair`'s leased port or `gave-up`'s
 *                    dropped evidence, no part of it survives that bail, so a
 *                    row banked at the branch can assert a turn that never
 *                    committed. Files under the turn whose terminal was vetoed,
 *                    not turnIdx + 1 — the +1 convention belongs to a message
 *                    read on the next turn.
 *   repair           a guard that fixed the ENVIRONMENT instead of steering the
 *                    model: framework-serve registering the dev server a
 *                    promoted "done" caused the verify adapter to skip. Outside
 *                    the conversation entirely, so unlike `rewrite` the turn is
 *                    untouched. Minted at the branch — a leased port and a
 *                    registered server are already real, and neither a later
 *                    gate nor a Stop takes them back — and ONLY on
 *                    `handled && ok`; see the failed-registration entry below.
 *   gave-up          a guard that held a real adverse verdict, had no budget
 *                    left for it, and let the turn stand: render-verify's
 *                    capReached, which returns with the drained runtime errors
 *                    dropped over the model's "done". Not an abort — the turn
 *                    stays `done` and the op succeeds. Minted at the branch
 *                    because the drop already happened: render-verify.ts drains
 *                    the errors into a nudge string it discards and does not
 *                    even increment the retry counter there, so deferring the
 *                    fire to a settled terminal would lose it on every turn a
 *                    later gate re-opened — UNDER-counting a real effect.
 *
 * NOT COUNTED — read a 0 with these in mind:
 *   - a `continue` verdict: a guard that looked and let the turn pass.
 *   - a FAILED framework-serve registration (`handled && !ok`). `handled` alone
 *     means only that the gate recognised a framework app; with `ok:false` the
 *     op ends with no server registered, which is the state the gate exists to
 *     prevent, so a `repair` row would assert a repair that did not happen —
 *     the same rule that keeps a collapsed abort bubble and a `stableMessageId`
 *     nudge uncounted. It is the one path that logs a warning
 *     (`dev-server registration failed`), so read a low `repair` count against
 *     that log line, never as a dead gate.
 *   - a directive discarded by a user cancel: driveTurn bails before the
 *     post-commit apply, so the verdict never reached the op. The two `reopen`
 *     producers above obey the same rule by riding the same seam.
 *   - the continuation guard's OTHER TWO re-opening branches. All three of
 *     `middlewareNudged || failureNudged || injectsPending` veto the terminal
 *     identically, but the first two SPOKE: appendNudgeAsUserMessage already
 *     wrote their row (`nudge`), at the gate for a middleware directive and at
 *     decide-outcome's own tool-failure summary. A `reopen` beside those would
 *     count one user-visible act twice, so ONLY the silent third branch is
 *     counted here — the same rule that keeps a re-opening GATE's nudge from
 *     also filing a `reopen`.
 *   - THE OTHER FOUR HARNESS-AUTHORED TERMINALS. The harness writes its own
 *     closing assistant message in six places and counts TWO. Uncounted:
 *       `empty-turn-*`        empty-turn-termination.ts, a fully-empty
 *                             interactive turn
 *       `ask-user-*`          ask-user-terminal.ts, a trailing question made
 *                             the visible answer
 *       `open-steps-warn-*`   terminal-epilogue.ts, the loud-partial warning
 *       `ground-truth-sizes-* terminal-epilogue.ts, real file sizes over a
 *                             fabricated line count
 *     Only `empty-turn-*` shares the `appendHonestTerminal` writer with the
 *     gate terminal's — that helper has exactly two call sites. The other three
 *     publish and push on their own, so a writer-based search finds neither
 *     them nor any future sibling; `build-verify-ok-*` is counted only because
 *     it was wired by hand. `outcome === "honest-terminal"` is therefore a
 *     census of TWO gates, not of harness-authored terminals — slice it as the
 *     former or four live code paths read as dead, the exact misreading this
 *     event exists to prevent.
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
 *  rides the same list, contributed at its own append inside the
 *  `!endedPartial` branch that decides whether the user ever sees it.
 *
 *  The silent `reopen` joins them, from BOTH its producers: a veto is nothing
 *  but an in-memory `terminalReason = null`, so a Stop in this same window
 *  erases it entirely and a row banked at the branch would assert a turn that
 *  never committed. It is contributed unconditionally rather than re-checked
 *  against a settled terminal: once a veto lands nothing restores the terminal,
 *  so the only question left is whether the turn commits at all.
 *
 *  NOT every gate fire belongs here. A fire whose effect is already SPENT when
 *  the gate returns is minted at the branch instead — the registered dev
 *  server, the dropped render errors — because for those the deferral protects
 *  nothing and would drop the fire on any turn that ends non-terminally. The
 *  ledger above says which, and why, per outcome.
 *
 *  NO IDEMPOTENCY KEY: two decideTurnOutcome calls for one turnIdx would bank
 *  two identical bodies. Not reachable through worker.ts today, but note that
 *  `recoverCommittedStrategyPivot` earns its exactly-once through a
 *  `stableMessageId` and this has no equivalent. */
export function bankEarnedFires(opId: string, turnIdx: number, fires: readonly GuardFire[]): void {
  for (const fire of fires) recordGuardFire(opId, turnIdx, fire);
}

/** decide-outcome.ts's continuation guard vetoing a terminal because a user
 *  follow-up was already queued — the `reopen` producer that is NOT a gate.
 *
 *  A DISTINCT NAME from late-inject's, on purpose. The two are the same user
 *  act separated only by arrival time, and the ledger above says to sum them
 *  for a census — but the guard runs BEFORE the gate chain, so when it fires
 *  lateInjectGate is never evaluated, and filing this under a gate's name would
 *  claim a gate ran that did not. `reason` carries which of the guard's three
 *  branches fired, because the other two are counted as their own nudges.
 *
 *  A value, not a factory: nothing about the veto varies per op, and both the
 *  fire and its two readers treat GuardFire as read-only. */
export const CONTINUATION_INJECT_FIRE: GuardFire = {
  name: "continuation-guard",
  reason: "injects-pending",
  outcome: "reopen",
};

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
