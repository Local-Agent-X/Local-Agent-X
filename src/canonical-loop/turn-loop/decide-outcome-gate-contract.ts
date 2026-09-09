/**
 * The completion-gate CONTRACT — the surface every gate implements and the
 * chain runner consumes: what a gate reads about the turn, what it hands back,
 * the shared CONTINUE verdict, and the fire a gate names for its own effect.
 *
 * Pure extraction from decide-outcome-gates.ts, which had reached the hard
 * 400-LOC source-hygiene ceiling (scripts/check-source-hygiene.mjs, MAX_LOC
 * 400, GRANDFATHERED empty) — the same "split before it fails; never
 * grandfather" practice decide-outcome.ts documents and that already produced
 * decide-outcome-run-gates.ts and empty-turn-termination.ts.
 *
 * This is the LEAF of the gate module graph: it imports no gate and no table,
 * so the gate-definition modules can depend on it while decide-outcome-gates.ts
 * depends on THEM — no import cycle, and no gate object in TDZ if a definition
 * module is ever the entry point. decide-outcome-gates.ts re-exports every type
 * declared here, so the public import path for the contract is unchanged.
 *
 * Nothing here changed in the split: the same declarations, in the same order,
 * that stood at the top of decide-outcome-gates.ts.
 */
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";
import type { GuardFire } from "./guard-fire.js";
import type { GuardOutcome } from "../types.js";

/** Everything a completion gate reads about the turn under decision. */
export interface CompletionGateContext {
  op: Op;
  turnIdx: number;
  toolCalls: ToolCall[];
  /** The turn's final user-facing assistant text — for gates that judge what
   *  the model SAID, not just what it did. Existing gates ignore it. */
  assistantText: string;
}

/** A gate's terminal message paired with the fire appending it earns. */
export interface GateHonestTerminal {
  text: string;
  fire: GuardFire;
}

export interface CompletionGateOutput {
  /** True → veto the terminal: the runner sets terminalReason=null and stops. */
  reopen: boolean;
  /**
   * Build-verify's held green confirmation, surfaced only when the op truly
   * ends this turn (build-verify is the sole gate that produces it). Other
   * gates leave it undefined.
   */
  buildVerifyConfirmation?: string;
  /**
   * A gate-authored, user-facing terminal message for a turn the gate LETS
   * end (reopen:false) but must not end silently — decide-outcome appends it
   * as the turn's assistant message via the same helper the empty-turn
   * terminator uses, AFTER the chain settles and only if the turn actually
   * stays "done" (a later gate's reopen discards it). Produced today only by
   * unresolved-tool-intent's second fire.
   *
   * The `fire` rides WITH the text: a gate must not predict its own effect, so
   * it names the fire its terminal would earn and only the code that actually
   * appends the text contributes it. One value, so the two cannot drift.
   */
  honestTerminal?: GateHonestTerminal;
}

/** A named completion gate. `evaluate` runs only while terminalReason is still
 *  "done" — the runner short-circuits the chain on the first reopen. */
export interface CompletionGate {
  name: string;
  evaluate: (ctx: CompletionGateContext) => CompletionGateOutput | Promise<CompletionGateOutput>;
}

export const CONTINUE: CompletionGateOutput = { reopen: false };

/** A gate's fire is named for the gate itself. Unlike a middleware — whose
 *  verdict carries its own `reason` field — a completion gate has no separate
 *  reason string, so the gate name is both halves. A gate fire is as
 *  interesting as a middleware fire and is counted the same way.
 *
 *  `outcome` is NOT derivable from the gate — the same gate fires in two
 *  shapes (unresolved-tool-intent nudges on its first fire and authors an
 *  honest terminal on every later one), so each call site states which.
 *
 *  A nudge fire is banked HERE because appendNudgeAsUserMessage records it on
 *  the path that writes the row: it is already in op_messages, and neither a
 *  later reopen nor a cancel can un-write it. A fire describing THIS turn's
 *  TERMINAL has neither property — see `honestTerminal` above.
 *
 *  KNOWN UNCOUNTED (guard-fire.ts carries the full ledger): late-inject
 *  re-opening the turn and framework-serve registering a dev server both act
 *  without speaking, a semantics expansion deliberately not made. The other two
 *  are not that case: build-verify's verifiedClean SPEAKS (terminal-epilogue.ts
 *  pushes `build-verify-ok-*`) and belongs on the earned-fire seam at THAT
 *  append, whose `!endedPartial` condition is decided after this chain;
 *  render-verify's capReached has already dropped the drained runtime errors
 *  irreversibly, so deferring its fire would under-count it. */
export const gateSource = (name: string, outcome: GuardOutcome): GuardFire => ({ name, reason: name, outcome });
