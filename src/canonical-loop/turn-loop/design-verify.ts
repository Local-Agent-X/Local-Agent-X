// Design-verification gate — the fifth and last turn-loop gate. By the time it
// runs, the app is not broken (render-verify), compiles (build-verify), and
// behaves (spec-probes). But "works" is not "looks designed": the render probe's
// screenshot judge ALSO scored the app's visual design 0–5 in the same vision
// call. A clearly-weak score (unstyled, emoji-as-icons, no hierarchy) is neither
// a broken render nor a compile error — it's a working-but-unpolished app. This
// gate turns a low score into a capped repolish nudge (up to MAX_RETRIES passes),
// framed as the concrete visible problems to fix — and, when the judge returned a
// per-axis breakdown, led by the weakest axis — so the same model repolishes what
// it shipped.
//
// Deliberately NUDGE-ONLY — it records no ledger verdict. The design score is
// subjective and the judge is fallible (the same reason spec-probes records
// nothing), so a low score must never demote an otherwise-honest outcome to
// partial. Score-absent ⇒ no nudge: a missing/garbled/broken-screenshot verdict
// can't trigger a rebuild. Per-op state clears on op terminal via
// clearDesignVerifyStateForOp (state-machine.ts).

import type { Op } from "../../ops/types.js";

/** The graded design block the screenshot judge produces (see vision-verify.ts).
 *  `score` is an integer 0–5 (5 = polished); `issues` are concrete visible flaws;
 *  `dimensions` is an optional per-axis breakdown so the nudge can lead with the
 *  weakest axis instead of one opaque number. */
export interface DesignScore {
  score: number;
  issues: string[];
  dimensions?: { hierarchy: number; spacing: number; color: number; states: number };
}

// A score at or below this triggers a rebuild. Raised from the original
// conservative 2 to 3 — the "Aggressive" bar chosen by the user (2026-07-25).
// A passable-but-mediocre 3/5 used to ship untouched; now a middling result also
// earns a repolish pass, because "works" was never the goal — "looks designed"
// is. The vision judge is still biased away from calling working apps broken, so
// this only ever spends build turns on genuinely sub-polished output; a real 4–5
// is left alone.
const RETRY_AT_OR_BELOW = 3;
// Up to this many repolish passes per op (was 1). More passes chase a low score
// toward "designed" instead of settling for the first mediocre result; the cap
// still bounds the loop so a stubbornly-hard design can't spin forever.
const MAX_RETRIES = 3;
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
/** Human labels for the per-axis scores, phrased as the fix, not the metric. */
const DIMENSION_LABELS: Record<keyof NonNullable<DesignScore["dimensions"]>, string> = {
  hierarchy: "visual hierarchy — make the title dominant and headings clearly distinct from body (size + weight), not near-uniform text",
  spacing: "spacing & alignment — commit to one spacing scale, add comfortable padding, and align content to a grid instead of cramped/ragged gaps",
  color: "color & contrast — use a coherent, deliberate palette with legible contrast, not a generic low-contrast template look",
  states: "states & affordances — add a real empty state, loading and hover/focus/disabled styling; don't ship only the data-full happy path",
};

/** The weak axes (≤ the retry threshold), worst first, as a lead-in block —
 *  empty when the judge gave no dimensions or none were weak. Leading with the
 *  named axis turns "scored 3/5" into "hierarchy 2/5: do X", which is actionable. */
function formatWeakDimensions(dims?: DesignScore["dimensions"]): string {
  if (!dims) return "";
  const weak = (Object.keys(DIMENSION_LABELS) as Array<keyof typeof DIMENSION_LABELS>)
    .map((k) => ({ k, v: dims[k] }))
    .filter((d) => d.v <= RETRY_AT_OR_BELOW)
    .sort((a, b) => a.v - b.v);
  if (weak.length === 0) return "";
  return "Weakest axes, fix these first:\n" +
    weak.map((d) => `- ${DIMENSION_LABELS[d.k]} (scored ${d.v}/5)`).join("\n") + "\n\n";
}

export function formatDesignNudgeForAgent(design: DesignScore): string {
  const issues = design.issues.slice(0, MAX_ISSUES);
  const body = issues.length > 0
    ? issues.map((i) => `- ${i}`).join("\n")
    : "- generic, unstyled, or template-default look with no clear visual hierarchy";
  const weakLead = formatWeakDimensions(design.dimensions);
  return (
    `Your app runs, but its visual design scored ${design.score}/5 — clearly below a ` +
    `polished, intentional result. This is NOT a runtime error; the app works.\n\n` +
    weakLead +
    `Fix the concrete design problems visible in the rendered page:\n\n` +
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
