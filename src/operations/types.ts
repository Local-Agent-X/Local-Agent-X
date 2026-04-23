/**
 * Operations — long-horizon goal orchestration layer.
 *
 * An Operation takes a high-level user goal ("build me a WooCommerce store")
 * and runs a multi-phase autonomous execution:
 *   1. Decompose goal → ordered phases
 *   2. For each phase, pick a matching protocol (if one exists) OR run ad-hoc
 *   3. Checkpoint progress to disk so we can resume after crash / user idle
 *   4. Report status + ask the user only when truly blocked
 *
 * Relationship to other primitives:
 *   Tool       = primitive action (browser, bash, http_request)
 *   Protocol   = pre-defined recipe (chain of tools with rollback/variables)
 *   Mission    = cron-scheduled recurring job
 *   Operation  = one-off long-horizon goal (uses protocols + ad-hoc tool calls)
 *
 * Operation is ABOVE Protocol — it orchestrates multiple protocols + raw tool
 * calls to achieve a user-stated outcome.
 */

export type OperationStatus =
  | "pending"     // decomposed, waiting to start
  | "running"     // phase executing
  | "paused"      // user paused or blocked waiting for input
  | "completed"   // all phases done
  | "failed"      // phase failed, no retry left
  | "cancelled";  // user cancelled

export type PhaseStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface OperationPhase {
  id: string;
  name: string;
  /** What this phase must achieve */
  goal: string;
  /** How we know it's done — checkable conditions */
  successCriteria: string[];
  /** Tools this phase is likely to need */
  suggestedTools: string[];
  /** Matching protocol (if any); null → ad-hoc execution */
  protocolName: string | null;
  status: PhaseStatus;
  startedAt?: number;
  completedAt?: number;
  attempts: number;
  lastError?: string;
  /** Arbitrary state produced during this phase (URLs, IDs, etc.) */
  output?: Record<string, unknown>;
}

export interface Operation {
  id: string;
  /** The user's original request, verbatim */
  goal: string;
  /** High-level summary the decomposer produced */
  summary: string;
  phases: OperationPhase[];
  status: OperationStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Index of the currently-executing / next phase */
  currentPhase: number;
  /** Cross-phase state — passed to each phase as context */
  sharedState: Record<string, unknown>;
  /** Log of user-facing progress events */
  events: OperationEvent[];
  /** Secret names the user has pre-blessed at operation_start: for these, browser_fill_from_secret
   *  skips the first-use approval gate on the secret's recorded origin. Scope is this operation only. */
  preBlessedSecrets?: string[];
}

export interface OperationEvent {
  ts: number;
  level: "info" | "progress" | "blocked" | "error" | "done";
  phaseId?: string;
  message: string;
}
