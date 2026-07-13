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
  /** Model-native chain-of-thought, normalized across providers (Grok/Cerebras/
   *  DeepSeek `reasoning`, Anthropic thinking blocks). Streamed live to a
   *  collapsible "Thinking" affordance ABOVE the answer bubble — never appended
   *  to message body and never persisted, so the reasoning stays out of chat
   *  history. Silent for models that don't emit reasoning; the tool-lifecycle
   *  events carry visibility for those. Clients that don't handle it ignore it. */
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; toolName: string; toolCallId?: string; args: unknown; riskLevel?: "low" | "medium" | "high"; context?: string; requiresApproval?: boolean }
  | { type: "tool_progress"; toolName: string; toolCallId?: string; message: string }
  | { type: "tool_end"; toolName: string; toolCallId?: string; result: string; allowed: boolean; status?: ToolResultStatus }
  // Internal onEvent-channel signal: the running per-op token total, relayed
  // from a canonical turn_committed's usage by the agent-runner so a caller's
  // onEvent closure (e.g. the agent-run driver in handler-events.ts) can key it
  // to its agentId and broadcast an `agent-update`. Never emitted onto the WS
  // as a "usage" type — the driver converts it to the existing agent-update
  // broadcast. Additive/optional; consumers that don't handle it ignore it.
  | { type: "usage"; totalTokens: number }
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
  | { type: "approval_resolved"; approvalId: string; toolName: string; approved: boolean }
  | { type: "context_status"; percentage: number; level: string; usedTokens: number; maxTokens: number; compacted: boolean }
  | { type: "visual"; kind: "emoji" | "text" | "shape" | "mood"; value: string; durationMs: number }
  // `parentOpId` (optional) carries spawn lineage: the id of the op whose agent
  // submitted this one (Op.parentOpId). The agents panel uses it to nest a
  // spawned op under its spawner. Absent when the spawner couldn't be identified
  // at submit time or on pre-lineage ops — consumers must treat it as optional.
  //
  // `opType` (optional) carries the op's real type (Op.type: e.g. "app_build",
  // "research", "self_edit", "freeform"). The agents panel keys the per-card
  // icon off it so distinct agent types get distinct glyphs instead of all
  // showing the hardcoded 'coder' icon. Absent on pre-lineage/legacy events —
  // consumers must treat it as optional and fall back to a generic icon.
  | { type: "bg_op_queued"; opId: string; task: string; provider: string; lane: string; queuePosition: number; parentOpId?: string; opType?: string }
  | { type: "bg_op_queue_reordered"; opId: string; queuePosition: number }
  | { type: "bg_op_started"; opId: string; task: string; provider: string; parentOpId?: string; opType?: string }
  // `totalTokens` (optional) is the running per-op token total, forwarded from
  // a turn_committed's usage. The agents panel scales a per-card token bar off
  // it. Additive/optional — absent for progress lines that don't carry usage
  // (lifecycle markers, errors) and for ops that don't emit canonical turns.
  | { type: "bg_op_progress"; opId: string; line: string; totalTokens?: number }
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
  // can track the opId for reconnect. After connection drops, the client
  // sends `{type:"reconnect_op", opId}` over WS and the server replays
  // missed canonical events via `reconnectOp(opId, sinceSeq)`. Stop button →
  // `{type:"stop", sessionId}` → terminateChat aborts the turn signal →
  // opCancel.
  | { type: "chat_op_started"; opId: string }
  // Mid-turn user inject lifecycle. Emitted when a user sends while a turn
  // is already in flight: `inject_queued` confirms the message landed in the
  // server's inject queue (paired with the client-generated injectId echoed
  // on the local bubble); `inject_consumed` fires when drainInjectsIntoTurn
  // pulls it into a turn iteration so the UI can drop the "queued" styling.
  | { type: "inject_queued"; injectId: string }
  | { type: "inject_consumed"; injectId: string }
  // Enforced plan mode flipped for this session (user's Plan toggle over WS).
  // enforced:false is the user's approval event — the standing mutation ban
  // is lifted. The UI mirrors the flag onto the composer's Plan chip.
  | { type: "plan_mode_changed"; enforced: boolean }
  // Out-of-band UI hint emitted by tools that want to surface a structured
  // affordance (op id, kill button, blocked reason) WITHOUT putting that
  // info in the model-visible result text. Originally added so BLOCKED
  // op_submit_async / self_edit results could carry the live op id to the
  // agent panel as a chip while the model never sees the id (and therefore
  // can't parrot it back as a fake delegation message — see
  // test/op-submit-async-self-block.test.ts).
  | { type: "tool_chip"; toolCallId?: string; chip: ToolChip }
  // Activity-clock keepalive emitted by the chat-ws manager while a turn is
  // live (2026-07-13 audit I3). A single long tool call (build, npm install)
  // can go >60s without events, tripping the client's stuck-stream watchdog
  // into a needless reconnect_op replay. Never buffered into chat.events and
  // never routed through onEvent — broadcast-only. Ignored by every client
  // handler except chat-stream-store.js applyEvent's default case, which
  // bumps lastActivityMs for any unrecognized type.
  | { type: "op_heartbeat" };
