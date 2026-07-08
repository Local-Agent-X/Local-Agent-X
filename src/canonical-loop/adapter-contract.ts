/**
 * Canonical-loop adapter contract — locked at v1 (PRD §15).
 *
 * Type-only file — NO runtime behavior, NO imports of canonical-loop runtime
 * code. The contract is what every adapter (Anthropic, Codex, build_app,
 * IDE, the FakeAdapter test fixture) implements. Codex (v1.1) must pass the
 * conformance suite against this contract without contract changes.
 *
 * Snake-case ↔ camelCase: PRD §15 prose uses snake_case (op_id, turn_idx);
 * TS keeps camelCase. The literal `kind` strings on AdapterReport ARE the
 * protocol values and stay snake_case as PRD specifies.
 *
 * The term `adapter_report` (NOT `adapter_signal`) is mandatory per PRD §5.
 */
import type {
  CanonicalMessage,
  ProviderStateEnvelope,
  RedirectInstruction,
  ToolCall,
  ToolDescriptor,
} from "./contract-types.js";

// Re-export the value-shape types so adapter authors can pull everything
// from a single import surface.
export type {
  CanonicalMessage,
  ProviderStateEnvelope,
  RedirectInstruction,
  ToolCall,
  ToolDescriptor,
} from "./contract-types.js";

// ── Adapter interface (PRD §15) ───────────────────────────────────────────

export interface Adapter {
  readonly name: string;
  readonly version: string;
  runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult>;
  /**
   * Cancel the in-flight turn. Optional `reason` propagates through the
   * adapter's AbortController so transports can implement reason-aware
   * cleanup (e.g. warm-pool kills the CLI process when reason matches
   * `/idle|stalled|stop/`, but drains gracefully on routine cleanup).
   * Adapters that don't honor reason are still spec-compliant — the
   * argument is informational only.
   */
  abort(reason?: unknown): Promise<void>;
}

export interface TurnInput {
  opId: string;
  turnIdx: number;
  messages: CanonicalMessage[];
  pendingRedirect?: RedirectInstruction;
  providerState?: ProviderStateEnvelope;
  tools: ToolDescriptor[];
  /**
   * True when `messages` is an ephemerally COMPACTED view of op_messages
   * (compact-history.ts swapped older turns for a summary). Additive v1
   * metadata: adapters ignore it; turn-loop copies it onto the committed
   * provider_state so context sizing never anchors on a compacted turn's
   * usage (its token counts describe the summary view, not the full replay).
   */
  viewCompacted?: boolean;
}

export type AdapterReport =
  | { kind: "stream_chunk"; body: unknown }
  /**
   * Liveness ping with no UI payload. Emitted while the adapter is making
   * progress the user shouldn't see yet — chiefly a reasoning model
   * streaming chain-of-thought into `reasoning_content`, which we
   * accumulate silently rather than render. The orchestrator resets its
   * idle watchdog on every report, so without this a long reasoning turn
   * (grok-4 family, o-series, etc.) emits nothing for minutes and gets
   * killed as "stalled" despite working. Consumers that only care about
   * visible output ignore it.
   */
  | { kind: "heartbeat" }
  /**
   * Emitted when an adapter post-processes its already-streamed text and
   * needs the UI to retract part of it. Used by openai-compat after the
   * tool-call-text-extractor synthesizes a tool call from JSON the model
   * emitted as content — the JSON was already streamed to the client; the
   * client should remove it from the rendered bubble.
   *
   * `replacementText` is the cleaned text the bubble should display
   * instead of whatever it currently shows. Clients that don't handle
   * this event leave the dirty stream rendered (graceful degradation).
   */
  | { kind: "stream_redact"; replacementText: string }
  | { kind: "tool_call_requested"; call: ToolCall }
  /**
   * Emitted when the PROVIDER ran a tool itself, out of band — chiefly the
   * Anthropic CLI/OAuth path, where tools execute inside the `claude`
   * subprocess via MCP and surface to us only as `mcp_activity`. Unlike
   * `tool_call_requested` (which the loop dispatches), a `tool_observed`
   * tool has ALREADY run; the loop just records its NAME for op-category
   * telemetry and does NOT dispatch it.
   *
   * `tool` is the tool name; callers normalize any `mcp__<server>__` prefix
   * downstream, not here. Consumers that don't handle this kind ignore it
   * (graceful degradation), same as `heartbeat`.
   */
  | { kind: "tool_observed"; tool: string }
  | { kind: "message_finalized"; message: CanonicalMessage }
  | { kind: "error"; code: string; message: string; retryable: boolean };

export interface TurnResult {
  providerState: ProviderStateEnvelope;
  terminalReason?: "done" | "error";
  /**
   * The model's REAL terminal signal for this turn, normalized from the
   * provider's stop_reason / finish_reason (see `adapters/model-stop.ts`).
   * Distinct from `terminalReason`, which the adapter infers from turn SHAPE
   * (no tool calls + no error → done).
   *
   *   - "ended"    → the model declared the turn complete. `decide-outcome`
   *                  trusts this to terminate even a non-silent tool turn in
   *                  ONE pass, instead of driving an inferred wrap-up.
   *   - "continue" → the model wants more (tool_use / tool_calls) or was cut
   *                  off (max_tokens) — not a clean completion.
   *   - undefined  → this path/turn didn't surface a stop reason; the loop
   *                  falls back to its shape heuristics (the backstop).
   *
   * Adapters set this from the provider stop they already capture; absence is
   * always safe (the shape inference still terminates the turn).
   */
  modelStop?: "ended" | "continue";
}

// ── Adapter sandbox boundary (PRD §15 "Sandbox") ─────────────────────────
// These names are forbidden imports inside an adapter module. The
// conformance suite (Issue 02 item I) checks the adapter source against
// this list. Listed by module path / by export name as appropriate.

// Suffix-style entries — match any depth of relative path. The audit only
// flags `from "..."` / `require("...")` whose import string contains one of
// these substrings, so legitimate type-only imports of `adapter-contract` /
// `contract-types` / `types` are unaffected.
export const FORBIDDEN_ADAPTER_IMPORTS: readonly string[] = [
  "canonical-loop/store",
  "canonical-loop/store.js",
  "ops/op-store",
  "ops/op-store.js",
  "ops/event-log",
  "ops/event-log.js",
  "node:child_process",
  "child_process",
] as const;
