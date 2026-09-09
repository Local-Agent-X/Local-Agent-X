/**
 * The completion-gate chain runner — pure extraction of the loop that walked
 * COMPLETION_GATES inside decideTurnOutcome, split out for decide-outcome.ts'
 * hard 400-LOC ceiling. decide-outcome.ts still owns the terminal decision: it
 * hands the provisional terminalReason in and takes the settled one back out,
 * plus the two gate-produced payloads it surfaces only on a real terminal.
 *
 * Once the turn is provisionally "done", walk the single ordered gate table
 * (COMPLETION_GATES in decide-outcome-gates.ts) — render-verify → build-verify
 * → spec-probe → spec-audit → design-verify → unresolved-tool-intent →
 * earned-done → late-inject → framework-serve. Each gate runs ONLY while still
 * "done" and may veto the terminal by re-opening it (terminalReason → null),
 * which drives one more turn. This replaces a run of hand-inlined
 * `if (terminalReason === "done") { … }` blocks with the same short-circuit
 * and re-open semantics: the chain stops the moment a gate re-opens, exactly
 * as the per-block guard did. See the per-gate docs in decide-outcome-gates.ts
 * for each gate's own entry condition, nudge, and cap. Build-verify is the only
 * gate that also holds a green confirmation (surfaced by the epilogue when the
 * op truly ends this turn); unresolved-tool-intent is the only one that hands
 * back an honest terminal message (appended by decide-outcome only if the turn
 * actually stays "done").
 *
 * A gate's honest terminal — and a gate's SILENT REOPEN — carries the GUARD
 * FIRE its effect earns, and a gate never mints that fire itself. It cannot:
 * from inside `evaluate` it can see neither a later gate's reopen nor the cancel
 * window that follows the whole chain, and a fire recorded against either is a
 * durable claim about a turn that does not exist. The effect site contributes it
 * and turn-loop banks the result once the turn is DURABLE — guard-fire.ts
 * bankEarnedFires. For the reopen the effect site is this runner: it is what
 * acts on the veto, so it is what earns the fire.
 *
 * A turn that ends on a QUESTION is the one terminal the chain must not touch.
 * Every gate answers "did the model finish the work?", and re-opening drives
 * one more turn to finish it — but the missing input is the user's answer,
 * which does not exist yet, so the extra turn can only produce the guess this
 * whole mechanism exists to prevent. Their nudges would land on turn+1 (the
 * turn that carries the user's reply) as stale instructions, and build-verify
 * would spawn a real build to check work the agent explicitly paused. Skipping
 * is also what keeps decide-outcome's pre-commit inject gate sufficient: the
 * gates are the only awaits between it and the return, so with none of them
 * running no late inject can slip in unseen (that is exactly the window
 * lateInjectGate covers). The one thing given up is frameworkServeGate's side
 * effect — an app_build op that ends on a question registers no dev server —
 * which is correct: it is paused mid-build, not finished.
 */
import { COMPLETION_GATES, type CompletionGateContext, type GateHonestTerminal } from "./decide-outcome-gates.js";
import type { GuardFire } from "./guard-fire.js";

export interface RunCompletionGatesResult {
  terminalReason: "done" | "error" | null;
  /** Build-verify's held green confirmation ("" when none). */
  buildVerifyConfirmation: string;
  /** A gate's honest terminal for a turn that stays "done", with the fire that
   *  appending it earns. Null when no gate produced one. */
  honestTerminal: GateHonestTerminal | null;
}

export async function runCompletionGates(
  ctx: CompletionGateContext,
  terminalReason: "done" | "error" | null,
  endsOnQuestion: boolean,
  /** decide-outcome's earned-fire list, appended to in place — the same
   *  out-parameter shape applyTerminalEpilogue already uses for it. A silent
   *  reopen's fire goes HERE rather than into the return value so it cannot be
   *  read without also being banked. */
  earnedFires: GuardFire[],
): Promise<RunCompletionGatesResult> {
  let buildVerifyConfirmation = "";
  let honestTerminal: GateHonestTerminal | null = null;
  for (const gate of endsOnQuestion ? [] : COMPLETION_GATES) {
    if (terminalReason !== "done") break;
    const out = await gate.evaluate(ctx);
    if (out.buildVerifyConfirmation !== undefined) buildVerifyConfirmation = out.buildVerifyConfirmation;
    if (out.honestTerminal !== undefined) honestTerminal = out.honestTerminal;
    if (out.reopen) {
      terminalReason = null;
      // Inside `if (out.reopen)` so the fire cannot outlive its effect: a gate
      // that named one without vetoing banks nothing.
      if (out.reopenFire) earnedFires.push(out.reopenFire);
    }
  }
  return { terminalReason, buildVerifyConfirmation, honestTerminal };
}
