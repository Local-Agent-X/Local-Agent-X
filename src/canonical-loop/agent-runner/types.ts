import type { OpLane } from "../../ops/types.js";
import type { AgentOptions } from "../../providers/types.js";

export interface CanonicalAgentOptions extends AgentOptions {
  /** Op-level wall-clock ceiling. Replaces caller-side setTimeout-driven
   *  AbortControllers — when this fires, the runner calls opCancel so
   *  canonical's state machine sees a clean running → cancelling → cancelled
   *  transition. Defaults to 15 min if omitted. */
  wallClockMs?: number;
  /** Canonical op type tag (drives retry policy + soak metrics buckets).
   *  Defaults to "agent_turn". Bucket-specific values: "autopilot_round",
   *  "scheduled_mission", "memory_consolidation". */
  opType?: string;
  /** Canonical lane. Defaults to "background" — non-chat callers don't
   *  share the `interactive` cap with live chat turns. */
  lane?: OpLane;
  /** FieldAgent run id from invokeDefinition. Threaded through to the
   *  tool-execution context so per-run activity traces correlate with the
   *  AgentRunStore record. Absent for callers that aren't an agent spawn
   *  (e.g. cron missions, memory consolidation). */
  runId?: string;
}

export const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;
