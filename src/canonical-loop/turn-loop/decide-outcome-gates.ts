/**
 * Completion-gate table for decide-outcome.ts.
 *
 * decideTurnOutcome, once it has provisionally set terminalReason="done",
 * runs a fixed ordered chain of "should this turn actually end?" gates. Each
 * gate can veto the terminal by re-opening it (terminalReason → null), which
 * makes the worker drive one more turn (see decide-outcome.ts' continuation
 * comments). Historically this chain was a run of hand-inlined
 * `if (terminalReason === "done") { … }` blocks whose ordering — and the
 * subtle short-circuit that each block only runs while still "done" — lived
 * implicitly in source order.
 *
 * This module makes that ordering EXPLICIT and single-sourced: COMPLETION_GATES
 * is the one list, evaluated top to bottom, each entry a named gate. The
 * runner in decide-outcome.ts stops feeding gates the moment one re-opens the
 * turn (exactly the old `if (terminalReason === "done")` guard on every block),
 * so behavior is byte-for-byte identical to the inlined chain.
 *
 * A gate is pure w.r.t. the decision it returns (reopen or not); its documented
 * side effects (append a next-turn nudge, register app touches, stash the build
 * confirmation) are the same ones the inlined blocks performed, in the same
 * order.
 *
 * SIZE — this file reached the hard 400-LOC gate (scripts/check-source-hygiene.mjs,
 * MAX_LOC 400, GRANDFATHERED empty) and was split, per the practice
 * decide-outcome.ts documents: "Split before it fails; never grandfather."
 * The shared surface every gate implements moved to
 * decide-outcome-gate-contract.ts (re-exported below, so no import path
 * changed) and the five VERIFY gates — the ones that answer "does the WORK
 * hold up?" by running an external check on what the turn produced — moved to
 * decide-outcome-verify-gates.ts. What stayed is this file's own
 * responsibility: the ORDER, plus the gates that answer "is this turn OVER?"
 * from state already in hand (unresolved-tool-intent reads the final text,
 * earned-done the open-steps list, late-inject the inject queue) and the one
 * that finishes the terminal (framework-serve). Behavior is unchanged: the
 * gate objects, their bodies, and COMPLETION_GATES' order are identical.
 */
import { createLogger } from "../../logger.js";
import { hasInjects, opConsumesInjects } from "../../agent-loop/inject-queue.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { appendNudgeAsUserMessage } from "./nudges.js";
import { CONTINUE, gateSource, type CompletionGate } from "./decide-outcome-gate-contract.js";
import {
  buildVerifyGate,
  designVerifyGate,
  renderVerifyGate,
  specAuditGate,
  specProbeGate,
} from "./decide-outcome-verify-gates.js";
import { runToolIntentGate } from "./tool-intent-gate.js";
import { earnedDoneNudge } from "../middlewares/open-steps.js";

/** The gate contract lives in its own leaf module (no gate, no table) so the
 *  definition modules and this one cannot form an import cycle. Re-exported
 *  here because this file is the address every consumer already imports from —
 *  decide-outcome-run-gates.ts, tool-intent-gate.ts and the tests. */
export type {
  CompletionGate,
  CompletionGateContext,
  CompletionGateOutput,
  GateHonestTerminal,
} from "./decide-outcome-gate-contract.js";

const logger = createLogger("canonical-loop.framework-serve");

/**
 * Unresolved-tool-intent gate. A "done" whose final text still holds
 * recognized tool-call SYNTAX is not a done at all — the call never ran (the
 * 2026-09-08 muse-glimmer incident). Purely syntactic, on ranges alone: the
 * extractor excises every promoted range, so whatever remains is unresolved
 * even in a turn that also dispatched real calls. First fire per op re-opens
 * with the canonical wire-format nudge; every later fire lets the turn end
 * WITH an honest terminal the runner appends only if the turn truly stays
 * "done". Contract lives in tool-intent-gate.ts.
 */
export const unresolvedToolIntentGate: CompletionGate = {
  name: "unresolved-tool-intent",
  evaluate(ctx) {
    const gate = runToolIntentGate(ctx);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(ctx.op.id, ctx.turnIdx + 1, gate.nudge, gateSource("unresolved-tool-intent", "nudge"));
      return { reopen: true };
    }
    if (gate.honestTerminal !== undefined) {
      // tool-intent-gate.ts: "First fire per op → one retry nudge; every later
      // fire → honestTerminal". Only the first speaks through a nudge, so
      // without this an op that leaked tool syntax on ten turns would read 1.
      //
      // `honest-terminal`, not `nudge`: nothing is appended for the model to
      // read, and not `abort` either — the turn stays "done". The shape is what
      // separates this fire from the retry nudge above — same gate, same name,
      // same turnIdx. The fire travels WITH the text and is minted by neither
      // this gate nor the chain: a later gate can still reopen the turn, and
      // even a settled terminal is only in-memory until commitTurn. Whoever
      // appends the text earns the fire.
      return {
        reopen: false,
        honestTerminal: {
          text: gate.honestTerminal,
          fire: gateSource("unresolved-tool-intent", "honest-terminal"),
        },
      };
    }
    return CONTINUE;
  },
};

/**
 * Earned-"done" gate (unattended lanes only). Before accepting a worker /
 * background / build op's "done" while its own task list still has open steps,
 * force ONE more turn pointed at "finish or justify stopping". This is the
 * model-agnostic equalizer for runs nobody is watching: a weak model that hands
 * over a partial and waits for "continue" gets that push exactly once.
 * Interactive chat is excluded (earnedDoneNudge returns null) — never loop a
 * turn out from under the user. Bounded to one fire per op, so the second pass
 * falls through to the loud-partial warning below.
 */
const earnedDoneGate: CompletionGate = {
  name: "earned-done",
  evaluate({ op, turnIdx }) {
    const nudge = earnedDoneNudge(op);
    if (nudge) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, nudge, gateSource("earned-done", "nudge"));
      return { reopen: true };
    }
    return CONTINUE;
  },
};

/**
 * Late-inject re-check (CL-5). The pre-commit inject gate at the top ran BEFORE
 * the async verify gates (render/build/spec/design), each of which awaits —
 * yielding to the event loop so a user follow-up (pushInject that landed while
 * the turn was wrapping up) can arrive mid-turn. Re-read the queue here, the
 * LAST point the op is still `running` and session-bound: the very next step
 * (commitTurn in turn-loop.ts) fires transitionOp → succeeded, whose
 * state_changed synchronously runs releaseOpFromSession, so getSessionForOp
 * returns undefined from then on. Catching a late inject here keeps
 * terminalReason=null so the worker loops and drainInjectsIntoTurn pulls it in.
 * The worker-side gate could never see it — by the time the worker runs, the op
 * is already unbound from its session.
 */
const lateInjectGate: CompletionGate = {
  name: "late-inject",
  evaluate({ op }) {
    if (!opConsumesInjects(op.type)) return CONTINUE;
    const sessionId = getSessionForOp(op.id);
    if (sessionId && hasInjects(sessionId)) return { reopen: true };
    return CONTINUE;
  },
};

/**
 * Framework-serve gate (the live-server guarantee). A framework app_build's dev
 * server is registered by the verify adapter's smokeAndJudge — but ONLY when the
 * model's turn is natively "done" (app-build-verify-adapter.ts:148). P-1's
 * mutation-wrapup promotes a non-"done" turn to "done" downstream in
 * decide-outcome, AFTER the adapter already returned and skipped its
 * registration, so a framework build can terminate with NO dev server and render
 * a blank page (pawsit-dog-sitter-saas, 2026-07-12: installed + tsc-clean but
 * unreachable). Placed LAST so it fires only when no earlier gate re-opened —
 * i.e. the op is truly terminating this turn, whichever path produced the "done".
 * finalizeFrameworkBuild is idempotent (re-lease reuses the record's port) and a
 * no-op for static apps (returns {handled:false}), so a calculator gets nothing.
 * Side-effect only; never re-opens.
 */
const frameworkServeGate: CompletionGate = {
  name: "framework-serve",
  async evaluate({ op }) {
    if (op.type !== "app_build" || !op.appUrl) return CONTINUE; // APP_BUILD_OP_TYPE
    const appName = op.appUrl.match(/\/apps\/([^/]+)\//)?.[1];
    if (!appName) return CONTINUE;
    try {
      const { finalizeFrameworkBuild } = await import("../adapters/app-build-finalize.js");
      const { workspacePath } = await import("../../config.js");
      const finalized = await finalizeFrameworkBuild(
        { appDir: workspacePath("apps", appName), appName, laxPort: process.env.LAX_PORT ?? "7007", registerServer: true },
        {},
      );
      if (finalized.handled && !finalized.ok) {
        logger.warn(`op=${op.id} dev-server registration failed for "${appName}": ${finalized.message}`);
      }
    } catch (e) {
      logger.warn(`op=${op.id} dev-server registration threw for "${appName}": ${(e as Error).message}`);
    }
    return CONTINUE;
  },
};

/**
 * The single ordering source for the completion gates. Evaluated top to bottom
 * by decide-outcome.ts; the chain short-circuits on the first gate that
 * re-opens the turn. This order is load-bearing (build must clear before the
 * spec probe runs; the late-inject re-check must run AFTER the awaiting gates;
 * framework-serve runs LAST so it registers only on a real terminal) and MUST
 * match the sequence documented in decide-outcome.ts.
 */
export const COMPLETION_GATES: readonly CompletionGate[] = [
  renderVerifyGate,
  buildVerifyGate,
  specProbeGate,
  specAuditGate,
  designVerifyGate,
  // A "done" whose final text still holds tool-call syntax is not a done at
  // all — the call never ran. Sits BEFORE earned-done so the retry goes to
  // reissuing the call, not to an open-steps push. Contract in tool-intent-gate.ts.
  unresolvedToolIntentGate,
  earnedDoneGate,
  lateInjectGate,
  frameworkServeGate,
];

/** The gate names, in order — the documented sequence, for tests/tooling. */
export const COMPLETION_GATE_ORDER: readonly string[] = COMPLETION_GATES.map(g => g.name);
