// Design-verification gate — the fifth and last turn-loop gate. By the time it
// runs, the app is not broken (render-verify), compiles (build-verify), and
// behaves (spec-probes). But "works" is not "looks designed": the render probe's
// screenshot judge ALSO scored the app's visual design 0–5 in the same vision
// call. A clearly-weak score (unstyled, emoji-as-icons, no hierarchy) is neither
// a broken render nor a compile error — it's a working-but-unpolished app. This
// gate turns a low score into ONE capped rebuild nudge, framed as the concrete
// visible problems to fix, so the same model repolishes what it shipped.
//
// Deliberately NUDGE-ONLY — it records no ledger verdict. The design score is
// subjective and the judge is fallible (the same reason spec-probes records
// nothing), so a low score must never demote an otherwise-honest outcome to
// partial. Score-absent ⇒ no nudge: a missing/garbled/broken-screenshot verdict
// can't trigger a rebuild. Per-op state clears on op terminal via
// clearDesignVerifyStateForOp (state-machine.ts).

import type { Op } from "../../ops/types.js";

/** The graded design block the screenshot judge produces (see vision-verify.ts).
 *  `score` is an integer 0–5 (5 = polished); `issues` are concrete visible flaws. */
export interface DesignScore {
  score: number;
  issues: string[];
}

// A score at or below this triggers ONE rebuild. Conservative on purpose: a wrong
// low score spends a full build turn (the judge is biased away from calling things
// broken for exactly this reason), so only clearly-weak designs (0–2: unstyled /
// no hierarchy / emoji-as-icons) qualify — a passable 3+ is left alone.
const RETRY_AT_OR_BELOW = 2;
const MAX_RETRIES = 1;
/** Cap on issues listed in the nudge so a long list doesn't flood the transcript. */
const MAX_ISSUES = 8;

// Per-op design verdict, recorded by the render probe when it captured a
// screenshot of a NON-broken app. Drained once by the gate so an unchanged app
// isn't re-nagged across turns; a fresh probe on the next app-touching turn
// re-records it.
const VERDICTS = new Map<string, DesignScore>();
const RETRIES = new Map<string, number>();
// The exact mandated design spec for the op (selectDesignBrief().brief), stashed
// by build_app at op-create so BOTH vision-judge paths (the render probe and the
// app-build terminal gate) can score the render against the SAME required tokens
// — turning a generic "looks unstyled" score into "used the wrong palette/font".
const DESIGN_SPECS = new Map<string, string>();

export function recordDesignVerdict(opId: string, design: DesignScore): void {
  VERDICTS.set(opId, design);
}

/** Stash the op's mandated design spec (exact palette/fonts/spacing). */
export function recordDesignSpec(opId: string, spec: string): void {
  if (spec) DESIGN_SPECS.set(opId, spec);
}

/** The op's mandated design spec, or undefined — read by the vision judges so
 *  the design score measures adherence to THESE tokens, not generic polish. */
export function getDesignSpec(opId: string): string | undefined {
  return DESIGN_SPECS.get(opId);
}

function drainDesignVerdict(opId: string): DesignScore | undefined {
  const d = VERDICTS.get(opId);
  if (d) VERDICTS.delete(opId);
  return d;
}

export function getDesignVerifyRetries(opId: string): number {
  return RETRIES.get(opId) ?? 0;
}

function bumpDesignVerifyRetries(opId: string): number {
  const next = (RETRIES.get(opId) ?? 0) + 1;
  RETRIES.set(opId, next);
  return next;
}

export function clearDesignVerifyStateForOp(opId: string): void {
  VERDICTS.delete(opId);
  RETRIES.delete(opId);
  DESIGN_SPECS.delete(opId);
}

/** Test-only — drop all per-op design-verify state. */
export function _resetDesignVerifyState(): void {
  VERDICTS.clear();
  RETRIES.clear();
  DESIGN_SPECS.clear();
}

// Terse, factual nudge — data plus context, no pep-talk (frontier models do worse
// with encouragement framing). NOT the runtime-error/CSP framing render-verify
// uses: the app WORKS, so the message is "polish these specific visible problems",
// carrying the judge's concrete issue list.
export function formatDesignNudgeForAgent(design: DesignScore): string {
  const issues = design.issues.slice(0, MAX_ISSUES);
  const body = issues.length > 0
    ? issues.map((i) => `- ${i}`).join("\n")
    : "- generic, unstyled, or template-default look with no clear visual hierarchy";
  return (
    `Your app runs, but its visual design scored ${design.score}/5 — clearly below a ` +
    `polished, intentional result. This is NOT a runtime error; the app works. Fix the ` +
    `concrete design problems visible in the rendered page:\n\n` +
    body +
    `\n\nRaise the visual quality: legible text contrast, a real visual hierarchy ` +
    `(size / weight / spacing), deliberate and consistent spacing, real iconography ` +
    `instead of emoji standing in for UI controls, and a layout that reads as designed ` +
    `rather than a default template. Then the work is finished.`
  );
}

export interface DesignVerifyGateResult {
  /** Formatted design-fix block for the next turn's user message (empty if none). */
  nudge: string;
  /** True when the gate is suppressing this turn's terminal "done". */
  shouldRetry: boolean;
  /** Retry cap reached — design still weak, but stop looping. The outcome label
   *  is NOT demoted (design is subjective; the gate records no verdict). */
  capReached: boolean;
}

export interface DesignVerifyOptions {
  /** Override the recorded design verdict (default: the per-op stash). Test seam. */
  design?: DesignScore;
}

const NO_RETRY: DesignVerifyGateResult = { nudge: "", shouldRetry: false, capReached: false };

/**
 * Decide whether to suppress this turn's terminal "done" because the app's
 * rendered design scored too low. Pure in-memory work (sync) — the vision call
 * that produced the score already ran inside the render probe.
 *
 * Contract (the caller enforces the entry gate — terminalReason === "done", and
 * only after the broken / build / spec gates were satisfied):
 *   - Reads and DRAINS the design verdict the render probe recorded this turn.
 *     No verdict → NO_RETRY (score-absent can't trigger a rebuild).
 *   - Score above the threshold → NO_RETRY.
 *   - Score at/below threshold, under cap → ONE nudge, shouldRetry=true.
 *   - At cap → capReached, shouldRetry=false. Records NO ledger verdict either
 *     way: a subjective, fallible score must never demote the outcome label.
 */
export function runDesignVerifyGate(op: Op, opts: DesignVerifyOptions = {}): DesignVerifyGateResult {
  const design = opts.design ?? drainDesignVerdict(op.id);
  if (!design) return NO_RETRY;
  if (design.score > RETRY_AT_OR_BELOW) return NO_RETRY;
  if (getDesignVerifyRetries(op.id) >= MAX_RETRIES) {
    return { nudge: formatDesignNudgeForAgent(design), shouldRetry: false, capReached: true };
  }
  bumpDesignVerifyRetries(op.id);
  return { nudge: formatDesignNudgeForAgent(design), shouldRetry: true, capReached: false };
}
