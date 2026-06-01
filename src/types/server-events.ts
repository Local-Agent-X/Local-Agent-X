import type { ToolResultStatus, AgentTurn } from "../types.js";

// ── Server Types ──

/**
 * Structured chip a tool can attach to its result so the UI renders an
 * out-of-band affordance (badge + optional action button) in the agent
 * panel. The chip carries machine identifiers (op ids) the model never
 * sees in its text channel — preventing the "model parrots its host op
 * id back as a fake delegation" failure mode.
 *
 * Tools emit a chip by including `metadata.chip: ToolChip` on their
 * `ToolResult`. The executor harvests it and emits a `tool_chip`
 * `ServerEvent` alongside the normal `tool_end`. The chat dispatcher
 * forwards both to SSE/WS; the client renders the chip below the
 * matching tool card.
 */
export interface ToolChip {
  /** Discriminator. Today: "blocked-by-op". Add new kinds as new affordances. */
  kind: "blocked-by-op";
  /** Short human label rendered on the chip ("Prior op in flight"). */
  label: string;
  /** Optional one-line subtitle ("yes import them"). Truncated by UI. */
  detail?: string;
  /**
   * Op id this chip refers to. **Server-side only** — used by client to
   * wire the kill-button to the right op. The model never receives the
   * chip event; it stays in the `onEvent` channel that flows to the UI.
   */
  opId?: string;
  /** Optional action buttons. UI renders one button per entry. */
  actions?: Array<{ label: string; tool: string; args?: Record<string, unknown> }>;
}

/**
 * Structured preview of an action awaiting approval. Discriminated by `kind`
 * so the UI can render an appropriate card (diff view, command box, etc.)
 * instead of the raw `argsPreview` JSON blob. Built by the preview factories
 * in approval-manager.ts and attached to the `approval_requested` event.
 */
export type ActionPreview =
  | { kind: "file"; path: string; diff: string; lineCount: { added: number; removed: number }; truncated: boolean }
  | { kind: "shell"; cmd: string; cwd: string; explanation?: string }
  | { kind: "network"; method: string; url: string; bodyPreview: string; bodyTruncated: boolean; domain: string }
  | { kind: "money"; amount: number; currency: string; recipient: string; source: string; formatted: string };

export type ServerEvent =
  | { type: "stream"; delta: string }
  /** Adapter-initiated stream replacement (tool-call-from-text extraction
   *  in openai-compat). Client swaps the bubble's text with `text` instead
   *  of appending. `delta` is omitted on this variant. */
  | { type: "stream"; replace: true; text: string }
  | { type: "tool_start"; toolName: string; toolCallId?: string; args: unknown; riskLevel?: "low" | "medium" | "high"; context?: string; requiresApproval?: boolean }
  | { type: "tool_progress"; toolName: string; toolCallId?: string; message: string }
  | { type: "tool_end"; toolName: string; toolCallId?: string; result: string; allowed: boolean; status?: ToolResultStatus }
  | { type: "done"; usage: AgentTurn["usage"] }
  // Out-of-band notice that the turn stopped early (middleware abort,
  // wall-clock ceiling, stale evidence, loop detection, etc.). The UI
  // renders this as a small inline note BELOW the message, NOT as
  // appended message body — keeps technical jargon out of chat content
  // and out of persisted message history. `reason` is the user-friendly
  // one-liner; `debug` is the original technical text for diagnostics.
  | { type: "stopped"; reason: string; debug?: string; firedBy?: string }
  | { type: "error"; message: string }
  | { type: "secret_request"; name: string; service?: string; reason: string }
  | { type: "secrets_request"; secrets: Array<{ name: string; service?: string; reason: string }> }
  | { type: "approval_requested"; approvalId: string; toolName: string; toolCallId?: string; context: string; argsPreview: string; preview?: ActionPreview }
  | { type: "approval_timeout"; approvalId: string; toolName: string; toolCallId?: string }
  | { type: "context_status"; percentage: number; level: string; usedTokens: number; maxTokens: number; compacted: boolean }
  | { type: "visual"; kind: "emoji" | "text" | "shape" | "mood"; value: string; durationMs: number }
  | { type: "bg_op_queued"; opId: string; task: string; provider: string; lane: string; queuePosition: number }
  | { type: "bg_op_queue_reordered"; opId: string; queuePosition: number }
  | { type: "bg_op_started"; opId: string; task: string; provider: string }
  | { type: "bg_op_progress"; opId: string; line: string }
  | { type: "bg_op_completed"; opId: string; status: "completed" | "failed" | "cancelled"; summary: string; filesChanged: string[]; metadata?: Record<string, unknown>; resultUrl?: string }
  | { type: "bg_op_nudge"; opIds: string[]; text: string }
  // Antivirus interference detected. Bash tool detected ≥3 powershell
  // processes killed mid-stream within 60s — the AV-behavior-shield
  // signature. UI renders as a sticky banner with a one-time message
  // pointing at the project path the user should whitelist. Emitted
  // ONCE per server uptime so we don't spam.
  | { type: "av_blocked_warning"; platform: string; projectPath: string; message: string }
  // Worker narration → main chat thread (Step 1 of JARVIS-mode roadmap).
  // The worker's own LLM text deltas, surfaced as a distinct message bubble
  // in chat (not just the sidebar progress trace) so the user sees what the
  // worker is doing in real-time, conversationally. opId scopes the bubble
  // — multiple workers each get their own bubble, identified + styled
  // separately from the main agent's stream.
  | { type: "worker_stream"; opId: string; task?: string; delta: string }
  | { type: "worker_done"; opId: string; status: "completed" | "failed" | "cancelled"; summary?: string }
  // Canonical chat lifecycle: emitted at the START of a chat turn so the UI
  // can track the opId for reconnect/cancel. After connection drops, the
  // client sends `{type:"reconnect_op", opId}` over WS and the server
  // replays missed canonical events via `reconnectOp(opId, sinceSeq)`.
  // Stop button → `{type:"cancel_op", opId}` → `opCancel(opId)`.
  | { type: "chat_op_started"; opId: string }
  // Mid-turn user inject lifecycle. Emitted when a user sends while a turn
  // is already in flight: `inject_queued` confirms the message landed in the
  // server's inject queue (paired with the client-generated injectId echoed
  // on the local bubble); `inject_consumed` fires when drainInjectsIntoTurn
  // pulls it into a turn iteration so the UI can drop the "queued" styling.
  | { type: "inject_queued"; injectId: string }
  | { type: "inject_consumed"; injectId: string }
  // Out-of-band UI hint emitted by tools that want to surface a structured
  // affordance (op id, kill button, blocked reason) WITHOUT putting that
  // info in the model-visible result text. Originally added so BLOCKED
  // op_submit_async / self_edit results could carry the live op id to the
  // agent panel as a chip while the model never sees the id (and therefore
  // can't parrot it back as a fake delegation message — see
  // tests/op-submit-async-self-block.test.ts).
  | { type: "tool_chip"; toolCallId?: string; chip: ToolChip };
