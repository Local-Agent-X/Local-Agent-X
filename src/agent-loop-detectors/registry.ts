// The detector registry — the single source of truth for which post-turn
// detectors exist, the order they run in, their per-turn nudge budget, and
// whether they misfire on image replies. RetryBudget, RetryCounters,
// DEFAULT_RETRY_BUDGET, createRetryCounters, and the orchestrator's run loop
// all derive from this array, so adding a detector is a one-line append here
// rather than an edit across six parallel lists.
//
// DetectorKind (state.ts) stays a hand-written union rather than being derived
// from this array: deriving it would force a registry → detectors → state →
// registry import cycle. The `kind: DetectorKind` annotation below still makes
// TS reject any spec whose kind isn't a declared DetectorKind.

import {
  detectIncompleteMultiStep,
  detectPlanningOnly,
  detectSingleActionStop,
  detectReasoningOnly,
  detectEmptyResponse,
  detectUncommittedTurn,
  detectEvidenceStale,
} from "./detectors.js";
import type { DetectorKind, RetryInstruction, TurnState } from "./state.js";

export interface DetectorSpec {
  kind: DetectorKind;
  run: (state: TurnState) => RetryInstruction | null;
  /** Max nudges of this kind per turn before the orchestrator gives up. */
  budget: number;
  /**
   * When the user attached an image, the agent's expected reply is a
   * description, not an action plan. Detectors flagged here regex-match on
   * "I'll do X" phrasing and misfire on vision replies ("I see X; you could
   * try Y" reads as a stalled plan), so the orchestrator skips them in image
   * context. The others catch genuinely broken paths and stay enabled.
   */
  skipOnImages?: boolean;
}

// Order matters: earlier specs catch more specific patterns, later ones are
// broader fallbacks. incomplete-multistep runs first — when a turn both stalls
// a plan and leaves enumerated steps unfinished, its nudge (which preserves the
// per-step summaries the user asked for) is the right instruction to win.
export const DETECTORS: readonly DetectorSpec[] = [
  { kind: "incomplete-multistep", run: detectIncompleteMultiStep, budget: 8 },
  { kind: "planning-only",        run: detectPlanningOnly,        budget: 2, skipOnImages: true },
  { kind: "single-action-stop",   run: detectSingleActionStop,    budget: 2 },
  { kind: "reasoning-only",       run: detectReasoningOnly,       budget: 2 },
  { kind: "empty-response",       run: detectEmptyResponse,       budget: 2 },
  { kind: "uncommitted-turn",     run: detectUncommittedTurn,     budget: 1, skipOnImages: true },
  { kind: "evidence-stale",       run: detectEvidenceStale,       budget: 1, skipOnImages: true },
];
