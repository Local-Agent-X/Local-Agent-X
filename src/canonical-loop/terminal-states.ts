/**
 * Single canonical terminal-state vocabulary for the loop.
 *
 * The canonical state machine (state-machine.ts) emits `state_changed` events
 * whose `to` field is one of `succeeded | failed | cancelled` once the op
 * leaves the running/cancelling/paused continuum. Three runners (chat,
 * agent, control-api) all need to recognise that set; before this file each
 * redeclared its own `new Set([...])` locally — different files, identical
 * contents, durable drift hazard (F13).
 *
 * The companion `Run` contract in `src/agents/run.ts` re-exports `TerminalState`
 * so persistence and Handler call sites use the same vocabulary.
 */

export const TERMINAL_STATES = ["succeeded", "failed", "cancelled"] as const;

export type TerminalState = typeof TERMINAL_STATES[number];

/** Type guard — narrows an arbitrary string to TerminalState. */
export function isTerminalState(s: string | null | undefined): s is TerminalState {
  return s != null && (TERMINAL_STATES as readonly string[]).includes(s);
}
