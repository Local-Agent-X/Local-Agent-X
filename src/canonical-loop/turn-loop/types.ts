// Public result/options surface for driveTurn. Lives here (not in
// ../types.ts) so the orchestrator owns its own contract and the
// re-export from ../turn-loop.ts stays the one stable seam external
// callers (worker, index) import from.

export interface DriveTurnResult {
  terminalReason: "done" | "error" | null;
  toolCount: number;
  messageCount: number;
  /** True if the turn was aborted mid-flight via cancel; commit was skipped. */
  cancelled: boolean;
  /**
   * Set when a middleware in the canonical safety stack returned a non-
   * "continue" verdict. The worker uses this to override the natural
   * "break on terminal" logic — a `nudge` keeps the worker looping
   * (synthetic user message has been appended to op_messages), an `abort`
   * forces the worker to exit and transition the op to failed.
   */
  middlewareDirective?: {
    kind: "nudge" | "abort";
    reason: string;
    firedBy: string;
    message?: string;
  };
}

export interface DriveTurnOptions {
  /**
   * Optional cancel-check called after the adapter resolves runTurn and
   * again after tool dispatch. If it returns true, the partial turn is
   * discarded — no commitTurn, no op_turns row, no op_messages, no
   * turn_committed event (PRD §13: cancel discards the partial turn).
   */
  isCancelled?: () => boolean;
}

/** Sticky middleware directive across the turn's phases. The first
 *  non-`continue` verdict (from any phase) wins — same short-circuit
 *  semantics as agent-loop's runPhase per-phase short-circuit, lifted
 *  to a per-turn bubble so the worker can apply the verdict after
 *  commit. beforeTurn nudges are already consumed (synthetic message
 *  injected into THIS turn); we don't bubble them up. */
export type MiddlewareDirective =
  | { kind: "nudge"; reason: string; firedBy: string; message: string }
  | { kind: "abort"; reason: string; firedBy: string; message?: string };
