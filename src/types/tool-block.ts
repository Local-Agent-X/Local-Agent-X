// The block record and the kernel run state behind it. Split out of types.ts
// (same as server-events.ts) and re-exported from there so every
// consumer keeps its `../types.js` import.

/**
 * Every gate that can refuse a call, by name. A refusal's `metadata.layer` is
 * one of these (the ToolResult type requires it), so the chat notice, the
 * repeat-failure breaker and the block record read a closed set instead of a
 * free string: when a layer was spelled two ways, the control keyed on one of
 * them silently never rendered (2026-09-18).
 */
export const BLOCK_LAYERS = [
  // The pre-dispatch stages (tool-execution/enforce-policy.ts).
  "session-policy", "security", "rbac", "tool-policy", "threat", "arikernel", "approval",
  "tainted-shell", "hook", "circuit-breaker", "rate-limit",
  // The resolve phase and the runner.
  "plan-mode", "protected-files", "autopilot", "sandbox", "heap-guard",
  "side-effect-journal", "stale-read-guard", "learned-protocol-envelope",
  // Outbound gates (tool-execution/egress-gates.ts, browser/page-egress-taint.ts).
  "egress-guard", "egress-aggregate", "data-lineage", "canary",
  // Gates inside a tool.
  "browser-sensitive-page", "browser-human-verification", "browser-download", "browser-secret-on-screen",
  "android-sdk", "ask-user", "input-driver", "antivirus", "operator-only", "job-authority", "app-build",
  "dedup-cache", "plugin",
  /** Not a refusal: show_unblock_control re-surfacing a block's control on an
   *  ok result, so the chat renders the same notice. */
  "quarantine-notice",
  /** A refusal from nowhere the engine can name: a producer outside the type
   *  system named no layer and no active plugin owns the tool (an active
   *  plugin's is attributed to it as "plugin"). Never written by the engine. */
  "unknown",
] as const;

export type BlockLayer = (typeof BLOCK_LAYERS)[number];

export function isBlockLayer(value: unknown): value is BlockLayer {
  return typeof value === "string" && (BLOCK_LAYERS as readonly string[]).includes(value);
}

/**
 * The kernel run-state behind a blocked call, as the ARI wrapper reads it off
 * the firewall scope after a deny (src/ari-kernel/quarantine.ts). Scoped to the
 * canonical operation: the scope is built per op and discarded with it, so
 * nothing here outlives the turn.
 */
export interface KernelQuarantine {
  /** "behavioral_rule": a sequence rule refused THIS call and the run goes on.
   *  "threshold": this call's denial reached the denied-action limit and the
   *  run is now restricted. "external": a host-side alert restricted it.
   *  "restricted": a later call refused because the run was already restricted. */
  trigger: "behavioral_rule" | "threshold" | "external" | "restricted";
  rule?: string;
  reason: string;
  /** When the run entered restricted mode; absent while it has not. */
  restrictedAt?: string;
  /** The kernel's denied-action counter at the time of this call. */
  deniedActions: number;
  /** Denials that restrict the run; with deniedActions, where the run stands. */
  threshold?: number;
  /** The file path the matched sensitive-read event named, when the rule was
   *  sensitive_read_then_egress. */
  matchedPath?: string;
}

/**
 * Durable, secret-free record of ONE blocked tool call — or of the control a
 * tool re-surfaced for a standing block (layer "quarantine-notice"). Built from
 * the result envelope at the tool-execution seam (tool-message-carry.ts),
 * carried on the tool message and the dispatch result, written to the op's
 * canonical event log (tool_finished.block) and to the tool_result row, and
 * rendered by the chat as the block notice. `notice` states what the UI is
 * expected to show, so a trace can tell a block that offered the user a
 * control from one that did not.
 */
export interface ToolBlockRecord {
  layer: BlockLayer;
  layers?: BlockLayer[];
  /** With layer "plugin": the plugin that refused (its owner id), so the chat
   *  can say which and the repeat-failure breaker groups by it. */
  plugin?: string;
  /** First line of the block reason, capped; never the payload. */
  reason: string;
  /** The next step the model was given (the rendered `Recovery:` line);
   *  always present on a refusal. */
  recovery?: string;
  /** "declassify": the user can lift a session taint; "allow-host": the user
   *  can allow `host` for web access. The chat renders the control off this. */
  clearable?: "declassify" | "allow-host";
  /** The host to allow, with clearable "allow-host". */
  host?: string;
  quarantine?: KernelQuarantine;
  /** Where the block state lives and what ends it. */
  scope?: "operation" | "session-memory";
  /** The inbox item the call is parked in, waiting for the user's yes
   *  (tool-execution/deferred-call.ts). Loop guards read this, not the text. */
  deferredTo?: string;
  notice: "declassify-card" | "allow-host-card" | "kernel-notice" | "none";
}
