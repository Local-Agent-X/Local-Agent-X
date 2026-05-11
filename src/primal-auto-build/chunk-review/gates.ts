/**
 * Five gate checks for a just-completed chunk. From the design memo's
 * "Gate machinery" section:
 *
 *   1. Done-when verifier        — fuzzy match agent's report to plan's done-when
 *   2. Additive-diff check       — most important; spec edits must never weaken
 *   3. Phase-gate detector       — halt at end-of-phase verification gates
 *   4. Launch-readiness emitter  — surface deferred items, enforce concrete verify steps
 *   5. Test-failure escalation   — new failures halt, pre-existing don't
 *
 * Each gate returns null (passed) or a GateFinding describing the action.
 * runReview (in index.ts) combines findings per the priority order:
 *   halt > push_back > amend_spec > proceed
 *
 * Detection is mechanical where possible — the Calenbella fixtures show
 * that the high-signal failure shapes leave clear textual fingerprints:
 *   - "silently" / "silent fallback" → Constitution-violation gray area
 *   - "deferred to launch-readiness" in NOTE with DONE_WHEN: met for a
 *     chunk whose done-when names an integration test → silent deferral
 *   - "two options:" / "decide unilaterally" in NOTE → agent surfaced a
 *     choice that demands a human, not a proceed
 *
 * LLM judgment can layer on top (chunk-12 needs it — recognizing an
 * implicit-spec gap requires reading the constitution). For chunk 4's
 * scope, the mechanical gates catch chunks 6 and 10 deterministically;
 * chunk 12 is handled by a separate spec-gap check that the loop wires
 * when an external judgment hook is supplied.
 */

import type { ParsedChunk, ParsedPlan } from "../plan-parser.js";
import type { ChunkReport } from "./report-parser.js";

export type ReviewAction = "proceed" | "amend_spec" | "push_back" | "halt";

export interface GateFinding {
  /** Which gate fired. Useful for logs + the user-facing halt message. */
  gate:
    | "report-shape"
    | "done-when"
    | "additive-diff"
    | "phase-gate"
    | "launch-readiness"
    | "test-failures"
    | "spec-gap-judgment";
  action: ReviewAction;
  /** One-sentence reasoning. Surfaced to the user on halts. */
  reasoning: string;
}

/** Gate 0 (precondition): the report must parse to a known shape. */
export function gateReportShape(report: ChunkReport): GateFinding | null {
  if (report.parsed) return null;
  return {
    gate: "report-shape",
    action: "halt",
    reasoning:
      "Chunk subprocess returned a report that doesn't match the expected " +
      "STATUS/DONE_WHEN/.../NOTE format. Either the subprocess timed out " +
      "mid-report or it skipped the report block. Do not commit.",
  };
}

/**
 * Gate 1: Done-when verifier.
 *
 * Failure modes detected mechanically:
 *
 *  (a) STATUS != "done" → chunk explicitly didn't ship → halt
 *  (b) DONE_WHEN == "unmet" or "unknown" → halt
 *  (c) DONE_WHEN == "deferred-to-launch-readiness" but the chunk's
 *      plan-level done-when names an "integration test" or specific
 *      observable behavior (not a launch-time concern) → halt; this is
 *      the chunk-6 silent-deferral pattern.
 *  (d) STATUS == "done", DONE_WHEN == "met", BUT the NOTE body contains
 *      a contradictory phrase ("deferred", "stub", "todo", "follow up",
 *      "didn't run") indicating the structured field is too optimistic
 *      → halt. This catches the chunk-6 case even when the agent
 *      mis-fills the structured field.
 */
export function gateDoneWhen(chunk: ParsedChunk, report: ChunkReport): GateFinding | null {
  if (report.status === "blocked" || report.status === "partial") {
    return {
      gate: "done-when",
      action: "halt",
      reasoning: `Chunk reported STATUS=${report.status}; needs user attention before continuing.`,
    };
  }

  if (report.doneWhen === "unmet" || report.doneWhen === "unknown") {
    return {
      gate: "done-when",
      action: "halt",
      reasoning: `Chunk reported DONE_WHEN=${report.doneWhen}. Done-when is the chunk's correctness contract — cannot proceed.`,
    };
  }

  // (c) Silent deferral pattern. The chunk's plan-level done-when names a
  // mechanical verification — if the agent says that's launch-readiness-
  // deferred, halt. The user has to acknowledge.
  if (report.doneWhen === "deferred-to-launch-readiness") {
    const isMechanicalContract = /\b(integration test|unit test|asserts?|returns?|test|passes?)\b/i.test(chunk.doneWhen);
    if (isMechanicalContract) {
      return {
        gate: "done-when",
        action: "halt",
        reasoning:
          `Chunk's done-when ("${truncate(chunk.doneWhen, 120)}") names a mechanical verification, ` +
          `but the report defers it to launch-readiness. This is the silent-deferral pattern — halt and surface to the user.`,
      };
    }
  }

  // (d) NOTE contradicts the structured field. Common Calenbella shape:
  // "DONE_WHEN: met" but NOTE says "the integration test is launch-readiness
  // deferred." That's the chunk-6 incident in a single check.
  if (report.doneWhen === "met") {
    const note = report.note.toLowerCase();
    const contradictoryPhrases = [
      "deferred to launch-readiness",
      "deferred-to-launch",
      "launch-readiness deferred",
      "integration test is launch-readiness",
      "didn't run the test",
      "did not run the test",
      "wasn't able to run",
      "test was skipped",
      "skipped the test",
    ];
    for (const phrase of contradictoryPhrases) {
      if (note.includes(phrase)) {
        return {
          gate: "done-when",
          action: "halt",
          reasoning:
            `Report says DONE_WHEN: met but NOTE contains "${phrase}". ` +
            `The structured field contradicts the prose — treat this as a silent deferral and halt.`,
        };
      }
    }
  }

  return null;
}

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

/**
 * Gate 4: Launch-readiness emitter.
 *
 * Doesn't halt by default — launch-readiness items are valid and expected.
 * But: any item must have a concrete "how to verify" step, not just
 * "test in staging." If LAUNCH_READINESS text is non-empty but lacks
 * concrete verb-phrases (set/run/assert/stand up/complete/verify) → halt
 * and ask the user to sharpen the item.
 */
export function gateLaunchReadiness(report: ChunkReport): GateFinding | null {
  const text = report.launchReadiness.trim();
  if (!text) return null;

  // Concrete verify steps contain at least one imperative verb phrase.
  const concreteVerbRe = /\b(set|run|stand up|complete|assert|verify|deploy|configure|enable|register|provision|invoke)\b/i;
  if (!concreteVerbRe.test(text)) {
    return {
      gate: "launch-readiness",
      action: "halt",
      reasoning:
        `LAUNCH_READINESS item lacks a concrete verify step. Each item must name how to verify it before launch ` +
        `(e.g. "set X env, run Y test, assert Z"), not just "test in staging". ` +
        `Got: "${truncate(text, 200)}"`,
    };
  }

  // Concrete enough — not a halt, but the loop should append to
  // LAUNCH_READINESS.md (chunk 7 wires that). We don't return a finding
  // here because launch-readiness with concrete steps is "proceed."
  return null;
}

/**
 * Gate 5: Test-failure escalation.
 *
 *   - NEW_FAILURES non-empty       → halt, name the failing tests
 *   - PRE_EXISTING_FAILURES only   → not a halt; loop logs as a punch-list item
 *   - both empty                   → pass
 */
export function gateTestFailures(report: ChunkReport): GateFinding | null {
  if (report.newFailures.length === 0) return null;
  return {
    gate: "test-failures",
    action: "halt",
    reasoning:
      `Chunk introduced ${report.newFailures.length} new test failure(s): ` +
      `${report.newFailures.slice(0, 5).join(", ")}` +
      `${report.newFailures.length > 5 ? ", ..." : ""}. Halt and surface to the user.`,
  };
}

/**
 * Optional gate: spec-gap judgment.
 *
 * Catches the chunk-10 (Constitution gray area) and chunk-12 (missing
 * implicit constraint) patterns. Looks at the NOTE body for:
 *
 *   - "Constitution #N" or "constitution" references → ambiguous case
 *   - "two options" / "decide unilaterally" / "surfaces the choice" →
 *     agent surfaced a fork; reviewer must halt for the user, not auto-decide
 *   - "silently" / "silent fallback" in NOTE without a fix in CHANGED →
 *     unresolved gray area
 *
 * The spec-gap judgment is intentionally separate from gateDoneWhen so
 * that the loop can pass it through an LLM if mechanical detection is
 * inconclusive. For chunks where the agent is explicit ("two options,
 * push back or accept"), mechanical detection suffices.
 */
export function gateSpecGapJudgment(report: ChunkReport): GateFinding | null {
  const note = report.note;
  const noteLc = note.toLowerCase();

  const forkPhrases = [
    "two options",
    "two paths",
    "decide unilaterally",
    "surfacing the choice",
    "your call",
    "user decides",
  ];
  for (const phrase of forkPhrases) {
    if (noteLc.includes(phrase)) {
      return {
        gate: "spec-gap-judgment",
        action: "halt",
        reasoning:
          `Agent's NOTE surfaces a fork ("${phrase}") — the choice between paths needs a human decision. ` +
          `Halt; let the user pick.`,
      };
    }
  }

  // Constitution-violation language without a concrete resolution in the
  // CHANGED set → halt. We don't claim to LLM-classify the violation;
  // we just refuse to barrel past Constitution-tagged unresolved
  // ambiguity. Conservative on purpose.
  if (/constitution\s*#?\s*\d+/i.test(note) && /\b(silent|gray area|theoretical|fallback|concern)\b/i.test(noteLc)) {
    return {
      gate: "spec-gap-judgment",
      action: "halt",
      reasoning:
        `NOTE references a Constitution rule + leaves it as a gray area / silent-fallback / theoretical concern. ` +
        `Constitution-tagged ambiguity must be resolved (fix code or amend spec) before proceeding.`,
    };
  }

  return null;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
