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
 *
 * Helpers split into ./anthropic/* — this file is the adapter class.
 */
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { CanonicalMessage, ProviderStateEnvelope } from "../contract-types.js";
import { canonicalToTransport } from "./canonical-to-transport.js";

import {
  ANTHROPIC_ADAPTER_NAME,
  ANTHROPIC_ADAPTER_VERSION,
  PROVIDER_STATE_MAX_BYTES_DEFAULT,
  type AnthropicAdapterOptions,
  type AnthropicTransport,
  type AnthropicTransportRequest,
  type StreamConsumeResult,
} from "./anthropic/types.js";
import { byteLengthUtf8, convertTools } from "./anthropic/helpers.js";
import { streamConsume, applyToolCallTextFallback } from "./anthropic/stream-consume.js";

export {
  ANTHROPIC_ADAPTER_NAME,
  ANTHROPIC_ADAPTER_VERSION,
  PROVIDER_STATE_MAX_BYTES_DEFAULT,
} from "./anthropic/types.js";
export type {
  AnthropicAdapterOptions,
  AnthropicTransport,
  AnthropicTransportRequest,
  TransportEvent,
  TransportMessage,
  TransportTool,
} from "./anthropic/types.js";

export class AnthropicAdapter implements Adapter {
  readonly name = ANTHROPIC_ADAPTER_NAME;
  readonly version = ANTHROPIC_ADAPTER_VERSION;

  private aborted = false;
  private aborter: AbortController = new AbortController();
  private inflight: Promise<StreamConsumeResult> | null = null;
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

    // Only force on the first turn — after the model has called the
    // forced tool once, subsequent turns should free up so it can finish
    // narrating / chaining follow-up calls. Same posture as the legacy
    // force-tool-use middleware.
    const forcedToolChoice = input.turnIdx === 0 ? this.opts.forcedToolChoice : undefined;
    const model = this.opts.model ?? "claude-opus-4-7";

    const req: AnthropicTransportRequest = {
      model,
      systemPrompt: this.opts.systemPrompt ?? "You are a helpful assistant.",
      messages: canonicalToTransport(input.messages, input.pendingRedirect, new Set(input.tools.map(t => t.name))),
      tools: convertTools(input.tools),
      signal: this.aborter.signal,
      maxTokens: this.opts.maxTokens,
      sessionId: this.opts.sessionId,
      forcedToolChoice,
    };

    // Idle-event detection lives in turn-loop now (provider-agnostic).
    // The adapter just yields events; turn-loop watches the report stream
    // and calls adapter.abort("idle-stalled") if no events for IDLE_TIMEOUT_MS.

    this.inflight = this.runStreamConsume(transport, req, report);
    let result: StreamConsumeResult;
    try {
      result = await this.inflight;
    } finally {
      this.inflight = null;
    }

    // Tool-call-in-text fallback: some turns emit a tool call as JSON in
    // the text channel instead of as a structured tool_use block. Detect
    // + rewrite. No-op for healthy turns.
    applyToolCallTextFallback(result, report, model, new Set(input.tools.map(t => t.name)));

    // Finalize the assistant message if any text was produced. A turn that
    // only emitted tool calls (no narration) finalizes nothing — the next
    // turn carries the tool_result(s) back to the adapter.
    let finalizedMessageId: string | null = null;
    if (result.assembledText.length > 0) {
      finalizedMessageId = `am-${input.opId}-${input.turnIdx}-${Date.now().toString(36)}`;
      const msg: CanonicalMessage = {
        messageId: finalizedMessageId,
        role: "assistant",
        content: { text: result.assembledText },
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
    } else if (result.interruptedByInject) {
      // Stream cut short by mid-turn user inject — NOT an error. terminalReason
      // is "done" so the worker checks hasInjects, sees true, and continues
      // to the next iteration where drainInjectsIntoTurn surfaces the inject
      // text. Treating this as "error" + sticky this.aborted (the old
      // behavior) killed the next iteration before the model could see the
      // inject. xAI Grok exposed this via HTTP streaming; the CLI
      // adapters happened to mask it but the bug is structurally the same.
      terminalReason = "done";
    } else if (result.firstError) {
      terminalReason = "error";
    } else if (result.toolCallIds.length > 0) {
      terminalReason = undefined;
    } else {
      terminalReason = "done";
    }

    let providerState: ProviderStateEnvelope = this.buildProviderState(input, {
      finalizedMessageId,
      stopReason: result.providerStop,
      pendingTools: result.toolCallIds.length,
      // Soak-metrics reads model + usage off providerPayload to compute
      // cost. Skip empty values so we don't pollute soak with zeros for
      // turns that didn't yield usage info.
      model,
      ...(result.usageInputTokens !== undefined ? { usageInputTokens: result.usageInputTokens } : {}),
      ...(result.usageOutputTokens !== undefined ? { usageOutputTokens: result.usageOutputTokens } : {}),
      ...(result.cacheReadTokens !== undefined ? { cacheReadTokens: result.cacheReadTokens } : {}),
      ...(result.cacheCreateTokens !== undefined ? { cacheCreateTokens: result.cacheCreateTokens } : {}),
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

  private async runStreamConsume(
    transport: AnthropicTransport,
    req: AnthropicTransportRequest,
    report: (r: AdapterReport) => void,
  ): Promise<StreamConsumeResult> {
    const result = await streamConsume(transport, req, report, {
      isAborted: () => this.aborted,
      sessionId: this.opts.sessionId,
    });
    // Mid-stream inject interrupt: streamConsume broke out of the loop and
    // flagged this on the result. Abort the transport's signal so the CLI
    // subprocess / HTTP request tears down promptly, but DO NOT set
    // this.aborted — that flag is sticky across runTurn calls and would
    // short-circuit the next iteration before drainInjectsIntoTurn could
    // surface the inject text. result.interruptedByInject flows through to
    // runTurn which picks terminalReason='done' so the worker continues.
    if (result.interruptedByInject) {
      try { this.aborter?.abort(); } catch { /* already aborted */ }
    }
    return result;
  }

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

/** Convenience factory for adapter-factory registration. */
export function createAnthropicAdapter(opts: AnthropicAdapterOptions = {}): AnthropicAdapter {
  return new AnthropicAdapter(opts);
}
