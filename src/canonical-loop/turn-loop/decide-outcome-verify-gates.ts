/**
 * The five VERIFY gates of the completion chain — render-verify, build-verify,
 * spec-probe, spec-audit, design-verify.
 *
 * Pure extraction from decide-outcome-gates.ts for the hard 400-LOC
 * source-hygiene ceiling it had reached, taking its piece the way
 * decide-outcome-run-gates.ts and empty-turn-termination.ts took theirs:
 * decide-outcome-gates.ts still owns the gate table and the ordering.
 *
 * THE SEAM: these are the gates that answer "does the WORK hold up?" by running
 * an EXTERNAL check against what the turn just produced — the live preview, the
 * project's own build, an executed acceptance probe, a fresh-context re-read of
 * the request, the screenshot judge's design score. The gates that stayed in
 * decide-outcome-gates.ts answer the other question, "is this turn OVER?", from
 * state already in hand (the final text, the open-steps list, the inject queue)
 * or finish the terminal. That is also why these five are contiguous and first:
 * they are exactly the awaiting gates the late-inject re-check exists to cover
 * (decide-outcome-run-gates.ts: "the async verify gates (render/build/spec/
 * design)").
 *
 * Nothing here changed in the split: each gate is the same object, with the
 * same doc and the same body, that lived in decide-outcome-gates.ts. ORDER is
 * NOT declared here — COMPLETION_GATES in decide-outcome-gates.ts remains the
 * single ordering source.
 */
import { appendNudgeAsUserMessage } from "./nudges.js";
import { CONTINUE, gateSource, type CompletionGate } from "./decide-outcome-gate-contract.js";
import { recordGuardFire } from "./guard-fire.js";
import { appIdsTouchedByTurn, registerOpAppTouch, runRenderVerifyGate, turnTouchedAppFiles } from "./render-verify.js";
import { runBuildVerifyGate } from "./build-verify.js";
import { runSpecProbeGate } from "./spec-probes.js";
import { runSpecAuditGate } from "./spec-audit.js";
import { runDesignVerifyGate } from "./design-verify.js";
import { opEditedSourceUnverified, opEditedSourcePaths } from "../middlewares/verify-gate.js";
import { userAuthoredRequest } from "../../slash-commands.js";

/**
 * Render-verify gate (Tier 1.A). When the model says "done" on a turn that
 * wrote/edited files under workspace/apps/<id>/, give the preview iframe a
 * moment to report any uncaught errors / unhandled rejections / console.errors
 * that landed after the reload. If errors arrive within the window, suppress the
 * terminal, prepend a formatted error block as a synthetic user message on the
 * next turn, and let the same model fix what it just broke. Capped at
 * MAX_RETRIES so an unfixable bug can't infinite-loop.
 */
export const renderVerifyGate: CompletionGate = {
  name: "render-verify",
  async evaluate({ op, turnIdx, toolCalls }) {
    if (!turnTouchedAppFiles(toolCalls)) return CONTINUE;
    // Let the phone-side ingress route this app's runtime errors to this op —
    // a phone-served page knows its appId, not a chat session id.
    for (const appId of appIdsTouchedByTurn(toolCalls)) registerOpAppTouch(op.id, appId);
    // appUrl lets the gate headlessly probe a build that no preview opened
    // (e.g. phone-triggered). appDescription is what the screenshot judge is
    // told the app IS (`The app is described as: "…"` in vision-verify.ts) —
    // the user's ask, not the methodology. On the chat path op.task is stamped
    // AFTER slash expansion, so for `/app-build a todo app` it is the marker
    // plus the whole SKILL.md body; userAuthoredRequest recovers
    // `/app-build a todo app` and passes a non-expansion through unchanged.
    // The judge never needs the template: the mandated design spec reaches it
    // separately via getDesignSpec(opId) inside the bootstrap probe.
    const gate = await runRenderVerifyGate(op.id, { appUrl: op.appUrl, appDescription: userAuthoredRequest(op.task ?? "") });
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge, gateSource("render-verify", "nudge"));
      return { reopen: true };
    }
    if (gate.capReached) {
      // capReached → leave terminalReason="done" but the errors are already
      // drained; the user sees the broken preview + the model's "done".
      //
      // MINTED HERE, and this is the exact OPPOSITE of build-verify's
      // confirmation despite the family resemblance. That one is contingent
      // (its append is decided later, inside the epilogue) so it rides the
      // earned-fire seam; this one is already SPENT. render-verify.ts drained
      // the runtime errors into a nudge string it then throws away and does not
      // even increment the retry counter on this branch, so the evidence is
      // gone before `evaluate` returns and no later re-open puts it back.
      // Deferring the fire to a settled terminal would drop it on every turn
      // that got re-opened for some other reason — under-counting a real,
      // irreversible effect, which is the failure this whole event exists to
      // end.
      //
      // `gave-up`, not `nudge` (nothing was appended) and not `abort` (the turn
      // stays "done" and the op succeeds): the guard had errors in hand, had no
      // retries left, and let the model's "done" stand over a broken preview.
      recordGuardFire(op.id, turnIdx, gateSource("render-verify", "gave-up"));
    }
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
export const buildVerifyGate: CompletionGate = {
  name: "build-verify",
  async evaluate({ op, turnIdx }) {
    if (!opEditedSourceUnverified(op.id)) return CONTINUE;
    const gate = await runBuildVerifyGate(op);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge, gateSource("build-verify", "nudge"));
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
export const specProbeGate: CompletionGate = {
  name: "spec-probe",
  async evaluate({ op, turnIdx }) {
    if (opEditedSourcePaths(op.id).length === 0) return CONTINUE;
    const gate = await runSpecProbeGate(op);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge, gateSource("spec-probe", "nudge"));
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
export const specAuditGate: CompletionGate = {
  name: "spec-audit",
  async evaluate({ op, turnIdx }) {
    if (opEditedSourcePaths(op.id).length === 0) return CONTINUE;
    const gate = await runSpecAuditGate(op);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge, gateSource("spec-audit", "nudge"));
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
export const designVerifyGate: CompletionGate = {
  name: "design-verify",
  evaluate({ op, turnIdx }) {
    const gate = runDesignVerifyGate(op);
    if (gate.shouldRetry) {
      appendNudgeAsUserMessage(op.id, turnIdx + 1, gate.nudge, gateSource("design-verify", "nudge"));
      return { reopen: true };
    }
    return CONTINUE;
  },
};
