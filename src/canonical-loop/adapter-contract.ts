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
}

export type AdapterReport =
  | { kind: "stream_chunk"; body: unknown }
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
  | { kind: "message_finalized"; message: CanonicalMessage }
  | { kind: "error"; code: string; message: string; retryable: boolean };

export interface TurnResult {
  providerState: ProviderStateEnvelope;
  terminalReason?: "done" | "error";
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
