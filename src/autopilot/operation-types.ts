/**
 * Operation record — autopilot's on-disk persistence container.
 *
 * Autopilot reuses this shape for persistence/events/status only; it runs its
 * OWN round loop (see loop.ts), not a phase machine, and writes operation.json
 * directly (start.ts / loop.ts:persistOp). The decompose-into-phases conductor
 * that originally defined these types has been removed — autopilot is now the
 * sole owner, so the types live here.
 *
 * `phases` / `summary` / `currentPhase` are vestigial for autopilot (it sets
 * `phases: []` and bypasses decomposition) but kept on the shape so the
 * persisted record stays self-describing and forward-compatible.
 */

import type { AutopilotConfig, RoundResult } from "./types.js";

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
  /** High-level summary (vestigial for autopilot) */
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
  /** Set when this Operation was created by autopilot. Persistence + status fields are reused;
   *  autopilot has its OWN loop (NOT a phase executor) and does NOT use the phase machinery. */
  autopilot?: AutopilotConfig;
  /** Per-round results, appended by autopilot loop. Empty for non-autopilot ops. */
  autopilotRounds?: RoundResult[];
}

export interface OperationEvent {
  ts: number;
  level: "info" | "progress" | "blocked" | "error" | "done";
  phaseId?: string;
  message: string;
}
