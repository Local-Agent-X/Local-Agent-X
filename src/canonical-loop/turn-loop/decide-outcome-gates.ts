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
 */
import type { Op } from "../../ops/types.js";
import type { ToolCall } from "../contract-types.js";
import { createLogger } from "../../logger.js";
import { hasInjects, opConsumesInjects } from "../../agent-loop/inject-queue.js";
import { getSessionForOp } from "../../ops/session-bridge.js";
import { appendNudgeAsUserMessage } from "./nudges.js";
import { appIdsTouchedByTurn, registerOpAppTouch, runRenderVerifyGate, turnTouchedAppFiles } from "./render-verify.js";
import { runBuildVerifyGate } from "./build-verify.js";
import { runSpecProbeGate } from "./spec-probes.js";
import { runSpecAuditGate } from "./spec-audit.js";
import { runDesignVerifyGate } from "./design-verify.js";
import { earnedDoneNudge } from "../middlewares/open-steps.js";
import { opEditedSourceUnverified, opEditedSourcePaths } from "../middlewares/verify-gate.js";

/** Everything a completion gate reads about the turn under decision. */
export interface CompletionGateContext {
  op: Op;
  turnIdx: number;
  toolCalls: ToolCall[];
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
}

/** A named completion gate. `evaluate` runs only while terminalReason is still
 *  "done" — the runner short-circuits the chain on the first reopen. */
export interface CompletionGate {
  name: string;
  evaluate: (ctx: CompletionGateContext) => CompletionGateOutput | Promise<CompletionGateOutput>;
}

const CONTINUE: CompletionGateOutput = { reopen: false };

const logger = createLogger("canonical-loop.framework-serve");

/**
 * Render-verify gate (Tier 1.A). When the model says "done" on a turn that
 * wrote/edited files under workspace/apps/<id>/, give the preview iframe a
 * moment to report any uncaught errors / unhandled rejections / console.errors
 * that landed after the reload. If errors arrive within the window, suppress the
 * terminal, prepend a formatted error block as a synthetic user message on the
 * next turn, and let the same model fix what it just broke. Capped at
 * MAX_RETRIES so an unfixable bug can't infinite-loop.
 */
const renderVerifyGate: CompletionGate = {
  name: "render-verify",
  async evaluate({ op, turnIdx, toolCalls }) {
    if (!turnTouchedAppFiles(toolCalls)) return CONTINUE;
    // Let the phone-side ingress route this app's runtime errors to this op —
    // a phone-served page knows its appId, not a chat session id.
    for (const appId of appIdsTouchedByTurn(toolCalls)) registerOpAppTouch(op.id, appId);
    // appUrl lets the gate headlessly probe a build that no preview opened
    // (e.g. phone-triggered); task is the description for the screenshot judge.
    const gate = await runRenderVerifyGate(op.id, { appUrl: op.appUrl, appDescription: op.task });
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge);
      return { reopen: true };
    }
    // gate.capReached → leave terminalReason="done" but the errors are
    // already drained; the user sees the broken preview + the model's
    // "done", same as today. Future: emit a one-line warning event.
    return CONTINUE;
  },
};

/**
 * Build-verify gate (iteration 5). When the model says "done" on an op that
 * edited source but never reached a clean self-verify, the orchestrator runs
 * the project's OWN build/type-check itself and injects the REAL errors as the
 * next turn's user message — the model dodges the gentle "go verify" nudge, so
 * the environment verifies and hands back ground truth instead. The build
 * verdict is recorded into the verify-gate ledger, so a clean run lets "done"
 * stand AND records `clean`, while a red run loops (capped) and the label
 * stays `partial`. Mirrors render-verify: orchestrator gate, never a tool call.
 */
const buildVerifyGate: CompletionGate = {
  name: "build-verify",
  async evaluate({ op, turnIdx }) {
    if (!opEditedSourceUnverified(op.id)) return CONTINUE;
    const gate = await runBuildVerifyGate(op);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge);
      return { reopen: true };
    }
    if (gate.verifiedClean) {
      // The orchestrator ran the project's build itself and it PASSED, but the
      // model couldn't self-verify (blocked from running a build on source paths)
      // and may have wrapped up sounding unsure. Hold the green confirmation and
      // surface it below once we know the op truly ends this turn.
      return { reopen: false, buildVerifyConfirmation: gate.confirmation };
    }
    return CONTINUE;
  },
};

/**
 * Spec-probe gate (iteration 6, the flagship). Build-green ≠ behaviorally
 * correct: the model can ship code that compiles yet does the wrong thing, and
 * its own self-tests miss it because it wrote them looking at the same buggy
 * implementation. So — only once the build gate above is satisfied
 * (terminalReason still "done") and the op edited source — the harness has the
 * SAME active model author an acceptance check while blind to the code (spec +
 * file names only), then EXECUTES it. A real spec-assertion failure injects one
 * capped retry nudge; a probe that can't validly run is discarded, never nudged,
 * so a correct implementation is never false-flagged. Nudge-only: unlike
 * build-verify it records no verdict, because the probe's authorship is fallible
 * and must never demote the outcome label.
 */
const specProbeGate: CompletionGate = {
  name: "spec-probe",
  async evaluate({ op, turnIdx }) {
    if (opEditedSourcePaths(op.id).length === 0) return CONTINUE;
    const gate = await runSpecProbeGate(op);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge);
      return { reopen: true };
    }
    return CONTINUE;
  },
};

/**
 * Spec-audit gate (the completeness gate). The executable gates above prove the
 * code compiles and behaves; none of them re-reads the REQUEST, so explicitly
 * requested work can be missing from a green build (a live user-facing string a
 * cleanup was told to remove). One fresh-context call: the same active model
 * re-reads the original request against the op's actual diff, conversation
 * hidden. Runs only when the op edited source. Nudge-only, fires at most once
 * per op, never demotes the label. Contract lives in spec-audit.ts.
 */
const specAuditGate: CompletionGate = {
  name: "spec-audit",
  async evaluate({ op, turnIdx }) {
    if (opEditedSourcePaths(op.id).length === 0) return CONTINUE;
    const gate = await runSpecAuditGate(op);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge);
      return { reopen: true };
    }
    return CONTINUE;
  },
};

/**
 * Design-verify gate (the fifth gate). Runs last of the app-quality gates —
 * only once the app is proven non-broken / compiling / behaving — turning a low
 * visual-design score from the render probe's screenshot judge into ONE capped
 * rebuild nudge. Nudge-only (records no verdict; never demotes the label).
 * Contract lives in design-verify.ts.
 */
const designVerifyGate: CompletionGate = {
  name: "design-verify",
  evaluate({ op, turnIdx }) {
    const gate = runDesignVerifyGate(op);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge);
      return { reopen: true };
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
      appendNudgeAsUserMessage(op.id, turnIdx + 1, nudge);
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
  earnedDoneGate,
  lateInjectGate,
  frameworkServeGate,
];

/** The gate names, in order — the documented sequence, for tests/tooling. */
export const COMPLETION_GATE_ORDER: readonly string[] = COMPLETION_GATES.map(g => g.name);
