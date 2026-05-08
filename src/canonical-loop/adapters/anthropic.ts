/**
 * Anthropic adapter — production implementation of the canonical adapter
 * contract (PRD §15, Issue 09).
 *
 * Sandbox boundary:
 *   - No DB, no `op_events`, no worker-pool, no `child_process` imports.
 *   - The adapter source MUST NOT mention any of `FORBIDDEN_ADAPTER_IMPORTS`.
 *     Subprocess management, OAuth, and stream parsing live behind the
 *     `AnthropicTransport` interface, whose default implementation is
 *     loaded from `./anthropic-transport.js` (which is allowed to use
 *     subprocess primitives — only this adapter file is audited).
 *
 * Streaming model:
 *   - `runTurn` consumes an async iterable of provider stream events from
 *     the transport and translates them into canonical `AdapterReport`s.
 *   - Text deltas → `stream_chunk` (bus-only, ephemeral) AND accumulated
 *     into a single assistant `message_finalized` at end of turn.
 *   - Provider tool-call events → `tool_call_requested` (the canonical
 *     loop dispatches via `tool-executor` and feeds the result back as a
 *     `tool_result` canonical message in the next turn).
 *   - Provider error events → `error` adapter_report. Routine errors are
 *     never thrown out of `runTurn` (PRD §15 / conformance H).
 *
 * `provider_state` envelope:
 *   - Always `{ adapterName: "anthropic", adapterVersion, providerPayload }`.
 *   - Payload is intentionally minimal — the canonical loop replays
 *     messages on every turn, so the provider doesn't need to remember
 *     a conversation id. We keep `lastTurnIdx` as a sanity marker.
 *   - 256 KB size cap (PRD §21). Oversize → caller observes an `error`
 *     report and a `terminalReason: "error"` TurnResult.
 *
 * Abort lifecycle:
 *   - `runTurn` mints a fresh `AbortController` per turn so the adapter
 *     instance can be reused across turns (conformance D, resume).
 *   - `abort()` flips an `aborted` flag (preempts the per-iteration loop)
 *     AND aborts the controller (signals the transport to tear down its
 *     subprocess / HTTP request). Idempotent (F) and safe after natural
 *     completion (G).
 *   - The promise returned by `runTurn` resolves once the transport
 *     iterable drains; the worker (Issue 06) sees `tracker.cancelled`
 *     and skips the post-turn commit.
 */
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { CanonicalMessage, ProviderStateEnvelope } from "../contract-types.js";
import { canonicalToTransport } from "./canonical-to-transport.js";

export const ANTHROPIC_ADAPTER_NAME = "anthropic";
export const ANTHROPIC_ADAPTER_VERSION = "1.0.0";
export const PROVIDER_STATE_MAX_BYTES_DEFAULT = 256 * 1024;

// ── Transport contract ───────────────────────────────────────────────────

export interface AnthropicTransportRequest {
  model: string;
  systemPrompt: string;
  messages: TransportMessage[];
  tools: TransportTool[];
  signal: AbortSignal;
  maxTokens?: number;
  /**
   * Chat session id, when this transport is driving a chat op. Used for
   * warm-pool keying so a session reuses a long-lived CLI process across
   * turns instead of cold-spawning per request.
   */
  sessionId?: string;
}

export interface TransportMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Required when role === "tool". */
  toolCallId?: string;
  /**
   * Optional assistant tool_calls for round-tripping function_call items
   * across turns. Codex's ChatGPT-backend doesn't support
   * `previous_response_id`, so the message history must include the
   * assistant's prior tool_call(s) before the matching tool_result —
   * otherwise the API rejects with "no tool call found for function call
   * output with call_id …". Set when role === "assistant" and the model
   * emitted tool calls; the per-provider transport translates this to the
   * underlying client's tool-call shape.
   */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface TransportTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type TransportEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "error"; code: string; message: string; retryable?: boolean }
  | {
      type: "done";
      stopReason?: string;
      /**
       * Optional usage from the underlying provider's terminal frame.
       * Captured into providerState so soak-metrics can read it without
       * subscribing to provider-specific shapes. Populated by both the
       * Anthropic and Codex transports when their respective `result` /
       * `done` events carry usage. Cache fields are Anthropic-specific —
       * Codex returns them as undefined.
       */
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreateTokens?: number;
      };
    };

export interface AnthropicTransport {
  stream(req: AnthropicTransportRequest): AsyncIterable<TransportEvent>;
}

// ── Adapter ──────────────────────────────────────────────────────────────

export interface AnthropicAdapterOptions {
  /** Defaults to a transport that wraps `streamAnthropicResponse`. */
  transport?: AnthropicTransport;
  /** Provider model id. Override per-op via a custom factory. */
  model?: string;
  /** System prompt applied to every turn. */
  systemPrompt?: string;
  /** Per-turn output token cap. */
  maxTokens?: number;
  /** PRD §21: 256 KB suggested cap on `provider_state` JSON size. */
  providerStateMaxBytes?: number;
  /**
   * When this adapter drives a chat op, the session id is propagated to
   * the transport so the warm pool reuses one CLI process across turns
   * for the session.
   */
  sessionId?: string;
}

export class AnthropicAdapter implements Adapter {
  readonly name = ANTHROPIC_ADAPTER_NAME;
  readonly version = ANTHROPIC_ADAPTER_VERSION;

  private aborted = false;
  private aborter: AbortController = new AbortController();
  private inflight: Promise<void> | null = null;
  private readonly transportPromise: Promise<AnthropicTransport>;

  constructor(private readonly opts: AnthropicAdapterOptions = {}) {
    this.transportPromise = opts.transport
      ? Promise.resolve(opts.transport)
      : import("./anthropic-transport.js").then(m => m.defaultAnthropicTransport());
  }

  async runTurn(
    input: TurnInput,
    report: (r: AdapterReport) => void,
  ): Promise<TurnResult> {
    if (this.aborted) {
      // Already-aborted adapter: clean error report, do not throw.
      report({
        kind: "error",
        code: "aborted",
        message: "adapter aborted before runTurn",
        retryable: false,
      });
      return {
        providerState: this.buildProviderState(input, { aborted: true }),
        terminalReason: "error",
      };
    }

    // Fresh abort controller per turn so a prior turn's abort doesn't poison
    // the next one. The adapter instance is reusable across turns
    // (conformance D / resume).
    this.aborter = new AbortController();

    const transport = await this.transportPromise;

    let assembledText = "";
    let finalizedMessageId: string | null = null;
    const toolCallIds: string[] = [];
    let firstError: { code: string; message: string } | null = null;
    let providerStop: string | undefined;
    let usageInputTokens: number | undefined;
    let usageOutputTokens: number | undefined;
    let cacheReadTokens: number | undefined;
    let cacheCreateTokens: number | undefined;

    const req: AnthropicTransportRequest = {
      model: this.opts.model ?? "claude-opus-4-7",
      systemPrompt: this.opts.systemPrompt ?? "You are a helpful assistant.",
      messages: canonicalToTransport(input.messages, input.pendingRedirect),
      tools: convertTools(input.tools),
      signal: this.aborter.signal,
      maxTokens: this.opts.maxTokens,
      sessionId: this.opts.sessionId,
    };

    // Idle-event detection lives in turn-loop now (provider-agnostic).
    // The adapter just yields events; turn-loop watches the report stream
    // and calls adapter.abort("idle-stalled") if no events for IDLE_TIMEOUT_MS.

    const consume = async (): Promise<void> => {
      try {
        for await (const ev of transport.stream(req)) {
          if (this.aborted) break;
          if (ev.type === "text") {
            if (ev.delta.length === 0) continue;
            assembledText += ev.delta;
            report({ kind: "stream_chunk", body: { delta: ev.delta } });
            continue;
          }
          if (ev.type === "tool_call") {
            toolCallIds.push(ev.id);
            report({
              kind: "tool_call_requested",
              call: {
                toolCallId: ev.id,
                tool: ev.name,
                args: parseArgs(ev.arguments),
              },
            });
            continue;
          }
          if (ev.type === "error") {
            // Routine errors come through as adapter_reports (PRD §15 H).
            // We capture the FIRST error and propagate via TurnResult.
            if (!firstError) {
              firstError = { code: ev.code, message: redactSecrets(ev.message) };
            }
            report({
              kind: "error",
              code: ev.code,
              message: redactSecrets(ev.message),
              retryable: ev.retryable === true,
            });
            continue;
          }
          if (ev.type === "done") {
            providerStop = ev.stopReason;
            if (ev.usage) {
              usageInputTokens = ev.usage.inputTokens;
              usageOutputTokens = ev.usage.outputTokens;
              cacheReadTokens = ev.usage.cacheReadTokens;
              cacheCreateTokens = ev.usage.cacheCreateTokens;
            }
            continue;
          }
        }
      } catch (e) {
        // Defensive: contract H says routine errors come via report,
        // not exceptions. If the transport throws, convert into an error
        // report and proceed. We never re-throw out of runTurn.
        const message = redactSecrets((e as Error).message ?? String(e));
        if (!firstError) firstError = { code: "transport_exception", message };
        report({ kind: "error", code: "transport_exception", message, retryable: false });
      }
    };

    this.inflight = consume();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }

    // Finalize the assistant message if any text was produced. A turn that
    // only emitted tool calls (no narration) finalizes nothing — the next
    // turn carries the tool_result(s) back to the adapter.
    if (assembledText.length > 0) {
      finalizedMessageId = `am-${input.opId}-${input.turnIdx}-${Date.now().toString(36)}`;
      const msg: CanonicalMessage = {
        messageId: finalizedMessageId,
        role: "assistant",
        content: { text: assembledText },
      };
      report({ kind: "message_finalized", message: msg });
    }

    // Compute terminalReason. Order:
    //   - aborted → error (worker discards the partial turn anyway).
    //   - any error → error.
    //   - tool calls outstanding → continue (next turn carries tool_result).
    //   - otherwise → done.
    let terminalReason: "done" | "error" | undefined;
    if (this.aborted) {
      terminalReason = "error";
    } else if (firstError) {
      terminalReason = "error";
    } else if (toolCallIds.length > 0) {
      terminalReason = undefined;
    } else {
      terminalReason = "done";
    }

    let providerState: ProviderStateEnvelope = this.buildProviderState(input, {
      finalizedMessageId,
      stopReason: providerStop,
      pendingTools: toolCallIds.length,
      // Soak-metrics reads model + usage off providerPayload to compute
      // cost. Skip empty values so we don't pollute soak with zeros for
      // turns that didn't yield usage info.
      model: this.opts.model ?? "claude-opus-4-7",
      ...(usageInputTokens !== undefined ? { usageInputTokens } : {}),
      ...(usageOutputTokens !== undefined ? { usageOutputTokens } : {}),
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheCreateTokens !== undefined ? { cacheCreateTokens } : {}),
    });

    // Size cap (PRD §21): fail loudly. Surface via error report so the
    // canonical loop can transition the op to `failed` cleanly.
    const sizeCheck = this.checkProviderStateSize(providerState);
    if (sizeCheck) {
      report({
        kind: "error",
        code: "provider_state_oversize",
        message: sizeCheck,
        retryable: false,
      });
      // Replace with a minimal envelope so the commit doesn't itself
      // exceed the cap.
      providerState = {
        adapterName: ANTHROPIC_ADAPTER_NAME,
        adapterVersion: ANTHROPIC_ADAPTER_VERSION,
        providerPayload: { error: "provider_state_oversize" },
      };
      terminalReason = "error";
    }

    return { providerState, terminalReason };
  }

  async abort(reason?: unknown): Promise<void> {
    this.aborted = true;
    try { this.aborter.abort(reason); } catch { /* ignore */ }
    if (this.inflight) {
      try { await this.inflight; } catch { /* swallow */ }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private buildProviderState(input: TurnInput, payload: Record<string, unknown>): ProviderStateEnvelope {
    return {
      adapterName: ANTHROPIC_ADAPTER_NAME,
      adapterVersion: ANTHROPIC_ADAPTER_VERSION,
      providerPayload: {
        lastTurnIdx: input.turnIdx,
        ...payload,
      },
    };
  }

  private checkProviderStateSize(env: ProviderStateEnvelope): string | null {
    const max = this.opts.providerStateMaxBytes ?? PROVIDER_STATE_MAX_BYTES_DEFAULT;
    const size = byteLengthUtf8(JSON.stringify(env));
    if (size > max) {
      return `provider_state size ${size} bytes exceeds cap ${max}`;
    }
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────


function convertTools(tools: TurnInput["tools"]): TransportTool[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description ?? "",
    parameters: ((t.inputSchema as Record<string, unknown>) ?? {}),
  }));
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

function byteLengthUtf8(s: string): number {
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x80) len += 1;
    else if (code < 0x800) len += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { len += 4; i++; }
    else len += 3;
  }
  return len;
}

/**
 * Best-effort secret redaction for transport-error messages. Provider
 * errors should never include the bearer token, but we belt-and-suspender
 * by stripping recognized prefixes if they ever leak in. Anything we
 * can't classify cheaply is left alone — the canonical contract requires
 * NO raw secrets in events, but the production transport already filters
 * upstream; this is a defensive last line.
 */
function redactSecrets(s: string): string {
  if (!s) return s;
  return s
    .replace(/sk-ant-[a-zA-Z0-9_\-]+/g, "[REDACTED_API_KEY]")
    .replace(/sk-ant-oat[a-zA-Z0-9_\-]+/g, "[REDACTED_OAUTH]")
    .replace(/oauth:[a-zA-Z0-9_\-\.]+/g, "[REDACTED_OAUTH]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [REDACTED]");
}

/** Convenience factory for adapter-factory registration. */
export function createAnthropicAdapter(opts: AnthropicAdapterOptions = {}): AnthropicAdapter {
  return new AnthropicAdapter(opts);
}
