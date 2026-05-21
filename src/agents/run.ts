/**
 * Canonical Run type — one shape for "an execution of an agent on a task."
 *
 * Today two near-duplicate shapes exist:
 *
 *   FieldAgent (src/agency/handler-types.ts) — the in-flight runtime
 *     record the Handler keeps in memory while the agent works.
 *
 *   AgentRun (src/agent-store.ts) — the persisted historical record
 *     written to ~/.lax/agent-runs/<id>.json when the run completes.
 *
 * Both describe the same conceptual entity: a single execution started
 * by something (the main agent, another agent, a schedule, the user)
 * and tracked until done. They diverged because they were written by
 * different layers at different times. The Run interface below is the
 * shared contract — both legacy types are structurally compatible with
 * it. Future consumers (UI run viewer, agent_status tool, audit log)
 * depend on Run; internal hot-path code (invokeDefinition's FieldAgent
 * lifecycle, AgentRunStore.save) keeps its existing shape for now.
 *
 * State machine (documented contract — not enforced in code):
 *
 *      idle  ─→ working ─→ succeeded
 *                       ─→ failed     (timeouts ride here with reason="timeout")
 *                       ─→ cancelled
 *
 *      working ⇄ waiting   (waiting = paused awaiting input; resumes to working)
 *
 * Terminal states match the canonical-loop's TERMINAL_STATES exactly
 * (src/canonical-loop/terminal-states.ts). Timeouts fold into `failed`
 * with `reason: "timeout"` on the run record; "error" and "timeout" as
 * distinct top-level statuses are gone.
 */

import type { TerminalState } from "../canonical-loop/terminal-states.js";
export type { TerminalState } from "../canonical-loop/terminal-states.js";

/** All possible run statuses. The terminal subset matches TerminalState
 *  exactly — anything that watches the canonical-loop bus and anything
 *  that reads/writes a persisted AgentRun agrees on the same vocabulary. */
export type RunStatus =
  | "idle"
  | "working"
  | "waiting"
  | TerminalState;

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "succeeded",
  "failed",
  "cancelled",
]);

export function isTerminalStatus(s: RunStatus): boolean {
  return TERMINAL_STATUSES.has(s);
}

/**
 * The shared shape. Optional fields are populated by the runtime when
 * known (FieldAgent during execution) or by the persistence layer when
 * the run completes (AgentRun). Anything matching this shape — by
 * TypeScript structural typing — is a Run; you don't need to explicitly
 * extend.
 */
export interface Run {
  /** Stable run id. Same value across FieldAgent.id and AgentRun.id —
   *  one execution, one id, traceable through both views. */
  id: string;
  /** Display name (often the agent's name from the catalog). */
  name: string;
  /** Agent role slug (researcher, coder, ceo, etc.). */
  role: string;
  /** What the agent was asked to do. */
  task: string;
  /** Current state. See state-machine diagram above. */
  status: RunStatus;
  /** Output lines accumulated so far. Empty array is fine for a
   *  freshly-spawned run that hasn't emitted anything. */
  output: string[];
  /** Wall-clock start. ms since epoch. */
  startedAt: number;

  /** System prompt the agent ran under. Set by the spawner; persisted
   *  in the final record. Optional only because some early-lifecycle
   *  in-memory views omit it before resolving the catalog entry. */
  systemPrompt?: string;
  /** Tokens consumed across this run. May be 0 until the first model
   *  call returns usage info. */
  tokensUsed?: number;

  // ── Provenance ──────────────────────────────────────────────────
  /** Parent run id when this run was spawned by another agent. null
   *  (or absent) means "kicked off by the user / main session." */
  parentAgentId?: string | null;
  /** Chat session id that initiated the run. Used to thread streams
   *  back to the originating UI without globals. */
  parentSessionId?: string;
  /** Catalog template id when the run was invoked from a registered
   *  agent definition. Absent for ad-hoc paths (test fixtures, etc). */
  templateId?: string;
  /** Chat session id this run is bound to in the persistence layer.
   *  Often equals parentSessionId but not guaranteed (e.g. a heartbeat
   *  run has no chat). */
  sessionId?: string;

  // ── Terminal-state-only fields ──────────────────────────────────
  /** The agent's final result (summary or full output). Populated when
   *  status reaches a terminal state. */
  result?: string;
  /** Tool names called during the run. Useful for audit + UI filtering. */
  toolsUsed?: string[];
  /** Wall-clock completion. ms since epoch. Set when status reaches a
   *  terminal state. */
  completedAt?: number;
  /** Failure detail when status is "failed". */
  error?: string;
  /** Sub-classification for the terminal state. Today only "timeout"
   *  is meaningful — it tags a `failed` run that hit a wall-clock
   *  ceiling rather than an in-task error. Distinct from `error` so
   *  consumers can filter on it without parsing strings. */
  reason?: "timeout";
}

/**
 * Active-only view — the in-flight FieldAgent shape projects onto this.
 * Useful when a consumer specifically needs the runtime fields and
 * wants TypeScript to enforce their presence.
 */
export type ActiveRun = Run & {
  status: Exclude<RunStatus, TerminalState>;
  currentTask?: string;
};

/**
 * Persisted-only view — the AgentRun shape projects onto this. status
 * is always terminal. Useful for code paths that only deal with
 * history (UI run viewer, AgentRunStore.list consumers).
 */
export type PersistedRun = Run & {
  status: TerminalState;
  result: string;
  toolsUsed: string[];
  completedAt: number;
  systemPrompt: string;
};
