/**
 * The mechanical gates on a just-completed chunk, and the shapes every check
 * shares (GateFinding, CheckResult).
 *
 *   - Additive-diff check: spec edits must never weaken a constraint.
 *   - Phase-gate detector: the chunk that closes a phase pauses at its gate.
 *   - The worker's own word that it stopped (gate-done-when.ts).
 *
 * Each returns null (passed) or a GateFinding. runChunkReview (index.ts) takes
 * the strongest: halt > push_back > amend_spec > proceed.
 *
 * None of them reads prose a model wrote. Until 2026-11-26 four more did: a
 * report-shape gate, a launch-readiness wording gate, a test-failures gate
 * over the worker's own NEW_FAILURES line and a "two options" / "your call"
 * phrase gate over its NOTE. Each held or set aside a chunk on how a sentence
 * was put, and a gate that fired stopped the real checks from running at all.
 * What those were for is measured now (the build and tests, the held-out
 * scenarios, the skeptic) or stated in a typed field of the worker's report
 * (agents/report-tools.ts): how to verify what could not be shown here, and a
 * question only the owner can answer.
 */

import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";

export type ReviewAction = "proceed" | "amend_spec" | "push_back" | "halt";

export interface GateFinding {
  /** Which gate fired. Useful for logs + the user-facing halt message. */
  gate:
    /** The worker's run itself failed: a crash, a timeout, a cancel. */
    | "worker-run"
    /** The model account the build runs on refused the request: out of
     *  credits, or not signed in. No retry or other chunk can pass until the
     *  owner fixes it, so the build stops (loop/model-account.ts). */
    | "model-account"
    | "done-when"
    | "additive-diff"
    | "phase-gate"
    | "spec-gap-judgment"
    | "build-exec"
    | "chunk-scenarios"
    | "chunk-unjudged"
    | "build-refused"
    /** The chunk's work conflicts with what landed, or still holds conflict markers. */
    | "worktree-merge"
    | "skeptic";
  action: ReviewAction;
  /** One-sentence reasoning. Surfaced to the user on halts. */
  reasoning: string;
  /** build-refused: the command this machine stopped, and what stopped it. */
  refused?: { command: string; what: string };
}

/**
 * What a check found. Three answers, never two: a check that could not run on
 * this machine did not pass and did not fail, and reading it as either has
 * cost a fix round or hidden a gap every time. `failed` is the only one that
 * goes back to a worker; `not-run` is owed to the owner.
 */
export type CheckResult =
  | { kind: "passed"; note?: string }
  | { kind: "failed"; finding: GateFinding }
  | { kind: "not-run"; why: string };

// Gate 1 (done-when verifier) lives in gate-done-when.ts — the largest single
// gate. Re-exported so callers keep one import.
export { gateDoneWhen } from "./gate-done-when.js";

/**
 * Gate 2: Additive-diff check. The MOST IMPORTANT gate per the design.
 *
 * This is the chunk-6 incident codified: a spec amendment proposed by
 * the review pass (or by the loop in response to a review finding) must
 * never relax a constraint, remove a done-when criterion the chunk
 * didn't meet, or lower a launch-readiness bar.
 *
 * Implementation: classifyDiff parses a unified diff. It walks removal
 * lines; each removal is classified as "replaced-with-stricter-equivalent"
 * (an immediately-adjacent addition reads as a stricter restatement) or
 * "weakened" (no stricter replacement). Any "weakened" → halt.
 *
 * The "stricter equivalent" heuristic is intentionally conservative:
 * unless we see an additive line nearby with strict keywords ("must",
 * "required", "always", "forbidden", "≥", "fails when"), a removal is
 * treated as weakening. False positives on this gate are recoverable
 * (user authorizes); false negatives (silently weakening spec) are not.
 */
export function gateAdditiveDiff(specDiff: string): GateFinding | null {
  if (!specDiff.trim()) return null; // no spec changes → nothing to gate

  const findings = classifyDiff(specDiff);
  if (findings.weakened.length > 0) {
    const sample = findings.weakened[0];
    return {
      gate: "additive-diff",
      action: "halt",
      reasoning:
        `Spec amendment is non-additive: ${findings.weakened.length} removed line(s) appear to weaken constraints. ` +
        `Example removed line: "${truncate(sample, 140)}". ` +
        `Spec amendments must only add new constraints or replace existing ones with stricter versions — never relax.`,
    };
  }
  return null;
}

interface DiffFindings {
  weakened: string[];
  /** Removals that look replaced-with-stricter-equivalent. Recorded but not blocking. */
  stricterReplacements: string[];
  additions: string[];
}

export function classifyDiff(unifiedDiff: string): DiffFindings {
  const lines = unifiedDiff.split(/\r?\n/);
  const weakened: string[] = [];
  const stricterReplacements: string[] = [];
  const additions: string[] = [];

  const strictKeywords = /(must|required|always|never|forbidden|≥|>=|<=|≤|fails when|enforces?|invariant|guarantees?)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) continue;
    if (line.startsWith("+") && !line.startsWith("++")) {
      additions.push(line.slice(1));
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("--")) {
      const removed = line.slice(1);
      // Look for an adjacent addition (within 3 lines forward) that reads as a stricter restatement.
      let foundStricter = false;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (lines[j].startsWith("+") && !lines[j].startsWith("++")) {
          const added = lines[j].slice(1);
          if (strictKeywords.test(added) && !strictKeywords.test(removed)) {
            foundStricter = true;
            break;
          }
          // Or: addition is a near-superset of removal (longer + adds words)
          if (added.length > removed.length * 1.2 && containsMostWords(added, removed)) {
            foundStricter = true;
            break;
          }
        }
      }
      if (foundStricter) stricterReplacements.push(removed);
      else if (removed.trim().length > 0) weakened.push(removed);
    }
  }
  return { weakened, stricterReplacements, additions };
}

function containsMostWords(haystack: string, needle: string): boolean {
  const words = needle.toLowerCase().match(/\b\w{3,}\b/g) || [];
  if (words.length === 0) return false;
  const lower = haystack.toLowerCase();
  const present = words.filter(w => lower.includes(w));
  return present.length / words.length >= 0.7;
}

/**
 * Gate 3: Phase-gate detector. If the just-completed chunk is the last
 * chunk in its phase AND the Phase-verification-gates section mentions
 * that phase by name, halt with a "drive scenarios" instruction.
 */
export function gatePhaseGate(
  chunk: ParsedChunk,
  plan: ParsedPlan,
  allChunks: ParsedChunk[],
): GateFinding | null {
  if (!plan.phaseGatesRawSection) return null;

  // Is this chunk the last in its phase?
  const sameP = allChunks.filter(c => c.phase === chunk.phase);
  if (sameP.length === 0) return null;
  const last = sameP[sameP.length - 1];
  if (last.number !== chunk.number) return null;

  // Does the phase-gates section reference this phase by name?
  const phaseShortLabel = (chunk.phase.match(/Phase\s+([A-Z])/i) || [])[1];
  if (!phaseShortLabel) return null;
  const phaseRefRe = new RegExp(`\\bPhase\\s+${phaseShortLabel}\\b`, "i");
  if (!phaseRefRe.test(plan.phaseGatesRawSection)) return null;

  return {
    gate: "phase-gate",
    action: "halt",
    reasoning:
      `Chunk ${chunk.number} closes ${chunk.phase}, which has a verification gate. ` +
      `Drive the gate's scenarios manually (browser/staging), score satisfaction, then resume with starting_chunk=${chunk.number + 1}. ` +
      `See plan.md "Phase verification gates" section for the scenario list.`,
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
