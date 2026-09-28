// The block record and the kernel run state behind it. Split out of types.ts
// (400-LOC cap, same as server-events.ts) and re-exported from there so every
// consumer keeps its `../types.js` import.

/**
 * The kernel run-state behind a blocked call, as the ARI wrapper reads it off
 * the firewall scope after a deny (src/ari-kernel/quarantine.ts). Scoped to the
 * canonical operation: the scope is built per op and discarded with it, so
 * nothing here outlives the turn.
 */
export interface KernelQuarantine {
  /** "behavioral_rule" (a sequence rule fired on THIS call), "threshold" (the
   *  denied-action counter tripped), or "restricted" (a later call refused
   *  because the run was already restricted by one of the first two). */
  trigger: "behavioral_rule" | "threshold" | "restricted";
  rule?: string;
  reason: string;
  /** When the run entered restricted mode. */
  restrictedAt: string;
  /** The kernel's denied-action counter at the time of this call. */
  deniedActions: number;
  /** The file path the matched sensitive-read event named, when the rule was
   *  sensitive_read_then_egress. */
  matchedPath?: string;
}

/**
 * Durable, secret-free record of ONE blocked tool call. Built from the result
 * envelope at the tool-execution seam (block-record.ts), carried on the tool
 * message and the dispatch result, written to the op's canonical event log
 * (tool_finished.block) and to the tool_result row, and rendered by the chat
 * as the block notice. `notice` states what the UI is expected to show, so a
 * trace can tell a block that offered the user a control from one that did not.
 */
export interface ToolBlockRecord {
  layer: string;
  layers?: string[];
  /** First line of the block reason, capped; never the payload. */
  reason: string;
  clearable?: "declassify";
  quarantine?: KernelQuarantine;
  /** Where the block state lives and what ends it. */
  scope?: "operation" | "session-memory";
  notice: "declassify-card" | "kernel-notice" | "none";
}
