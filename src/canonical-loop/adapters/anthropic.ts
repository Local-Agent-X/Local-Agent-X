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
import { streamConsume } from "./anthropic/stream-consume.js";
import { classifyModelStop } from "./model-stop.js";
import { buildHostedTurnTrace } from "./hosted-turn-trace.js";
import { finalizeAssistantRow } from "./finalize-assistant.js";
import { reasoningPayload, replayableReasoning } from "./row-reasoning.js";

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
  /** Set once the API refused replayed thinking; later steps send none. */
  private replayOff = false;
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
    const model = this.opts.model ?? "claude-opus-4-8";

    const toolNames = new Set(input.tools.map(t => t.name));
    const replay = this.replayOff ? undefined : replayableReasoning(input.messages, "anthropic", model, input.ephemeralTailMessages);
    const req: AnthropicTransportRequest = {
      model,
      systemPrompt: this.opts.systemPrompt ?? "You are a helpful assistant.",
      messages: canonicalToTransport(input.messages, input.pendingRedirect, toolNames, input.cacheFrontierMessageId, replay),
      tools: convertTools(input.tools),
      signal: this.aborter.signal,
      maxTokens: this.opts.maxTokens,
      sessionId: this.opts.sessionId,
      forcedToolChoice,
      preferDirectHttp: this.opts.preferDirectHttp,
      disableThinking: this.opts.disableThinking,
      effort: this.opts.effort,
      systemStablePrefixLen: this.opts.systemStablePrefixLen,
      cacheConversation: this.opts.cacheConversation ?? true,
      systemTailInMessages: this.opts.systemTailInMessages,
      // Per-turn, from the loop's own input — the digest row build-input.ts
      // appends is volatile, so the cache breakpoint must land beneath it.
      ephemeralTailMessages: input.ephemeralTailMessages,
    };

    // Idle-event detection lives in turn-loop now (provider-agnostic).
    // The adapter just yields events; turn-loop watches the report stream
    // and calls adapter.abort("idle-stalled") if no events for IDLE_TIMEOUT_MS.

    const startedAt = Date.now();
    this.inflight = this.consumeWithReplay(transport, req, report, () =>
      canonicalToTransport(input.messages, input.pendingRedirect, toolNames, input.cacheFrontierMessageId), (replay?.size ?? 0) > 0);
    let result: StreamConsumeResult;
    try {
      result = await this.inflight;
    } finally {
      this.inflight = null;
    }

    const finalizedMessageId = finalizeAssistantRow("am", input, {
      text: result.assembledText,
      toolCalls: result.toolCalls,
      reasoningPayload: reasoningPayload("anthropic", model, result.thinkingBlocks),
    }, report);

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

    // Real terminal signal — the model's stop_reason, normalized. decide-outcome
    // trusts this over the shape inference when present. See model-stop.ts.
    return { providerState, terminalReason, modelStop: classifyModelStop(result.providerStop), trace: anthropicTrace(req, result, startedAt) };
  }

  async abort(reason?: unknown): Promise<void> {
    this.aborted = true;
    try { this.aborter.abort(reason); } catch { /* ignore */ }
    if (this.inflight) {
      try { await this.inflight; } catch { /* swallow */ }
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * One step, sending back the tool loop's thinking blocks when there are any.
   * Should the API refuse them (a 400 naming a thinking block or its
   * signature) before anything came back, the step is sent again once without
   * them and replay stays off for this adapter's later steps: the model then
   * works from the visible text, as it did before replay existed. The refusal
   * itself is not reported, so the loop does not see a failed turn.
   */
  private async consumeWithReplay(
    transport: AnthropicTransport,
    req: AnthropicTransportRequest,
    report: (r: AdapterReport) => void,
    withoutReplay: () => AnthropicTransportRequest["messages"],
    replaying: boolean,
  ): Promise<StreamConsumeResult> {
    if (!replaying) return this.runStreamConsume(transport, req, report);
    const held: AdapterReport[] = [];
    const first = await this.runStreamConsume(transport, req, (r) => (r.kind === "error" ? held.push(r) : report(r)));
    if (refusedReplay(first)) {
      this.replayOff = true;
      return this.runStreamConsume(transport, { ...req, messages: withoutReplay() }, report);
    }
    for (const r of held) report(r);
    return first;
  }

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

/** The API refused the replayed thinking, and nothing else came back. */
function refusedReplay(r: StreamConsumeResult): boolean {
  return !!r.firstError && r.assembledText.length === 0 && r.toolCalls.length === 0
    && /\b(thinking|redacted_thinking)\b.*\bblock|\bsignature\b/i.test(r.firstError.message);
}

/** The turn's trace. Anthropic counts cache reads and writes outside
 *  input_tokens, so the prompt is their sum. */
function anthropicTrace(req: AnthropicTransportRequest, r: StreamConsumeResult, startedAt: number) {
  const cached = r.cacheReadTokens;
  const prompt = r.usageInputTokens === undefined ? undefined : r.usageInputTokens + (cached ?? 0) + (r.cacheCreateTokens ?? 0);
  return buildHostedTurnTrace({
    model: req.model,
    systemPrompt: req.systemPrompt,
    messages: req.messages,
    tools: req.tools,
    maxTokens: req.maxTokens,
    reasoningEffort: req.effort,
    toolChoice: req.forcedToolChoice,
    options: {
      disableThinking: req.disableThinking,
      preferDirectHttp: req.preferDirectHttp,
      systemStablePrefixLen: req.systemStablePrefixLen,
      cacheConversation: req.cacheConversation,
      systemTailInMessages: req.systemTailInMessages,
      ephemeralTailMessages: req.ephemeralTailMessages,
    },
  }, {
    text: r.assembledText,
    thinking: r.assembledThinking,
    toolCalls: r.toolCalls,
    stopReason: r.providerStop,
    promptTokens: prompt,
    completionTokens: r.usageOutputTokens,
    cachedTokens: cached,
    firstTokenMs: r.firstEventAt === undefined ? undefined : r.firstEventAt - startedAt,
    error: r.firstError,
  }, startedAt);
}

/** Convenience factory for adapter-factory registration. */
export function createAnthropicAdapter(opts: AnthropicAdapterOptions = {}): AnthropicAdapter {
  return new AnthropicAdapter(opts);
}
