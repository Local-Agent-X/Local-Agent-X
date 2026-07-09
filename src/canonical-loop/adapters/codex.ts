/**
 * Codex adapter — v1.1 implementation of the canonical adapter contract.
 * Structurally mirrors anthropic.ts; the transport calls the Codex
 * Responses API instead of the Anthropic CLI proxy.
 *
 * `previousResponseId` chaining: Codex threads encrypted reasoning
 * across turns via this ID. We store it in `provider_state` at the end
 * of each turn and read it back at the start of the next, passing it to
 * the transport so the model can reconstruct its reasoning context
 * without resending it as plaintext.
 */
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { CanonicalMessage, ProviderStateEnvelope } from "../contract-types.js";
import type { CodexTransport } from "./codex-transport.js";
import type { AnthropicTransportRequest } from "./anthropic.js";
import { canonicalToTransport } from "./canonical-to-transport.js";
import { hasInjects } from "../../agent-loop/inject-queue.js";
import { extractToolCallsFromText } from "./tool-call-text-extractor.js";
import { classifyModelStop } from "./model-stop.js";
import { withTransportRetry } from "./transport-retry.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.codex");

export const CODEX_ADAPTER_NAME = "codex";
export const CODEX_ADAPTER_VERSION = "1.0.0";
export const CODEX_PROVIDER_STATE_MAX_BYTES = 256 * 1024;

// How many guided retries to attempt after a truncated/empty turn before giving
// up. A model may need more than one nudge to switch from a one-shot oversized
// call to incremental calls; capped so a model that can't adapt still
// terminates (open-steps then surfaces the partial) instead of looping.
const MAX_TRUNCATION_RETRIES = 2;

// Artifact-agnostic recovery guidance fed to the model after its tool call was
// truncated at the subscription endpoint's output cap. The earlier version named
// `write`/`edit` specifically, which is useless for a binary artifact like a
// .pptx — the model ignored it and re-emitted the same oversized presentation
// call. This names the right incremental path per artifact type, including
// add_slide for presentations.
const TRUNCATION_RECOVERY_GUIDANCE =
  "Your previous response was cut off before it finished — that single tool call's output exceeded this provider's size limit. Do not repeat it as one large call. Build the artifact incrementally with several smaller calls: create it first with minimal content, then add each part in its own follow-up call. For a PowerPoint, use the presentation tool's `add_slide` action one slide at a time instead of putting every slide in a single `create`; for a document or spreadsheet, add sections or rows in separate edits; for a text file, `write` a small version then extend it with `edit`. Keep every individual tool call's payload modest (a few KB).";

export interface CodexAdapterOptions {
  transport?: CodexTransport;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  providerStateMaxBytes?: number;
  sessionId?: string;
  /**
   * Forced single-tool selection from the intent classifier. Applied on
   * turn 0 only — releases on later turns so the model can chain.
   */
  forcedToolChoice?: { type: "tool"; name: string };
}

export class CodexAdapter implements Adapter {
  readonly name = CODEX_ADAPTER_NAME;
  readonly version = CODEX_ADAPTER_VERSION;

  private aborted = false;
  private aborter: AbortController = new AbortController();
  private inflight: Promise<void> | null = null;
  private readonly transportPromise: Promise<CodexTransport>;

  constructor(private readonly opts: CodexAdapterOptions = {}) {
    this.transportPromise = opts.transport
      ? Promise.resolve(opts.transport)
      : import("./codex-transport.js").then(m => m.defaultCodexTransport());
  }

  async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
    if (this.aborted) {
      report({ kind: "error", code: "aborted", message: "adapter aborted before runTurn", retryable: false });
      return { providerState: this.buildProviderState(input, {}, undefined), terminalReason: "error" };
    }

    this.aborter = new AbortController();
    const transport = await this.transportPromise;

    // Read previousResponseId stored from the prior turn.
    const prevResponseId = (input.providerState?.providerPayload as Record<string, unknown> | undefined)
      ?.previousResponseId as string | undefined;

    let assembledText = "";
    let finalizedMessageId: string | null = null;
    const toolCallIds: string[] = [];
    // Track full tool_call info (not just IDs) so we can finalize an
    // assistant message that includes them — required for the next turn's
    // function_call_output to chain correctly through the API.
    const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let firstError: { code: string; message: string } | null = null;
    let providerStop: string | undefined;
    let newResponseId: string | undefined;
    let usageInputTokens: number | undefined;
    let usageOutputTokens: number | undefined;
    // Set when the streaming loop breaks because hasInjects() fired. Distinct
    // from this.aborted (cancel/error path) — terminalReason resolves to
    // "done" so the worker continues to the next iteration where
    // drainInjectsIntoTurn surfaces the inject. See openai-compat.ts /
    // anthropic.ts for the matching fix.
    let interruptedByInject = false;

    const forcedToolChoice = input.turnIdx === 0 ? this.opts.forcedToolChoice : undefined;

    const req: AnthropicTransportRequest & { previousResponseId?: string } = {
      model: this.opts.model ?? "gpt-5.4-mini",
      systemPrompt: this.opts.systemPrompt ?? "You are a helpful assistant.",
      messages: canonicalToTransport(input.messages, input.pendingRedirect, new Set(input.tools.map(t => t.name))),
      tools: convertTools(input.tools),
      signal: this.aborter.signal,
      maxTokens: this.opts.maxTokens,
      sessionId: this.opts.sessionId,
      previousResponseId: prevResponseId,
      forcedToolChoice,
    };

    // Idle-event detection lives in turn-loop now (provider-agnostic).

    const consume = async (): Promise<void> => {
      try {
        for await (const ev of withTransportRetry(
          () => transport.stream(req as Parameters<typeof transport.stream>[0]),
          { label: "codex", signal: req.signal, isAborted: () => this.aborted },
        )) {
          if (this.aborted) break;
          // Mid-stream user interrupt — same shape as anthropic.ts. When
          // the user types during a long in-stream tool-loop, abort the
          // stream so the next driveTurn drains the inject and the model
          // sees the user's message on its next API call.
          if (this.opts.sessionId && hasInjects(this.opts.sessionId)) {
            // DO NOT set this.aborted — sticky across runTurn calls, would
            // short-circuit the next iteration before the inject lands.
            interruptedByInject = true;
            try { this.aborter?.abort(); } catch { /* already aborted */ }
            break;
          }
          if (ev.type === "text") {
            if ((ev as { delta?: string }).delta?.length === 0) continue;
            assembledText += (ev as { delta: string }).delta;
            report({ kind: "stream_chunk", body: { delta: (ev as { delta: string }).delta } });
            continue;
          }
          if (ev.type === "thinking") {
            const d = (ev as { delta?: string }).delta;
            if (d) report({ kind: "reasoning_chunk", delta: d });
            continue;
          }
          if (ev.type === "tool_call") {
            const tc = ev as { id: string; name: string; arguments: string };
            toolCallIds.push(tc.id);
            pendingToolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
            report({ kind: "tool_call_requested", call: { toolCallId: tc.id, tool: tc.name, args: parseArgs(tc.arguments) } });
            continue;
          }
          if (ev.type === "error") {
            const err = ev as { code: string; message: string; retryable?: boolean };
            if (!firstError) firstError = { code: err.code, message: err.message };
            report({ kind: "error", code: err.code, message: err.message, retryable: err.retryable === true });
            continue;
          }
          if (ev.type === "done") {
            providerStop = (ev as { stopReason?: string }).stopReason;
            newResponseId = (ev as { responseId?: string }).responseId;
            const usage = (ev as { usage?: { inputTokens: number; outputTokens: number } }).usage;
            if (usage) {
              usageInputTokens = usage.inputTokens;
              usageOutputTokens = usage.outputTokens;
            }
            continue;
          }
        }
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        if (!firstError) firstError = { code: "transport_exception", message };
        report({ kind: "error", code: "transport_exception", message, retryable: false });
      }
    };

    this.inflight = consume();
    try { await this.inflight; } finally { this.inflight = null; }

    // Truncation recovery. The Codex/ChatGPT subscription endpoint caps a single
    // response's output and rejects max_output_tokens, so when the model tries
    // to emit a whole artifact in one oversized tool call it hits the cap, the
    // stream closes mid-emit, and the partial (invalid-JSON) call is dropped
    // (see flushOnAbnormalClose) — leaving a zero-text, zero-tool, zero-error
    // turn. A bare re-run repeats the identical oversized call, so we feed the
    // model artifact-agnostic guidance to build incrementally and retry a
    // bounded number of times. Fires ONLY on the silent-fail signature; healthy
    // turns are untouched. Mirror of the post-stream retry in openai-compat.ts.
    // Live failure 2026-05-14: chat-mp5psjdd-ersqf on gpt-5.5 — 120s turn, 0
    // output, 0 tools, no error. Live 2026-06-13: 20-slide deck truncated twice
    // because the old single retry steered to write/edit (useless for .pptx).
    const isTruncatedEmpty = () =>
      !this.aborted &&
      !interruptedByInject &&
      !firstError &&
      assembledText.length === 0 &&
      pendingToolCalls.length === 0;
    if (isTruncatedEmpty()) {
      req.messages = [...req.messages, { role: "user", content: TRUNCATION_RECOVERY_GUIDANCE }];
      for (let attempt = 1; attempt <= MAX_TRUNCATION_RETRIES && isTruncatedEmpty(); attempt++) {
        logger.info(`${req.model} returned a truncated/empty turn — retry ${attempt}/${MAX_TRUNCATION_RETRIES} with incremental-build guidance`);
        this.aborter = new AbortController();
        req.signal = this.aborter.signal;
        this.inflight = consume();
        try { await this.inflight; } finally { this.inflight = null; }
      }
    }

    // Still empty after the truncation-recovery retries — zero text, zero
    // tool calls, zero error, not aborted, not interrupted. Surface it as a
    // turn failure instead of finishing as a silent, contentless `done`.
    // The dominant real-world trigger is an expired/rotated ChatGPT OAuth
    // session (the user signed in on another device): the request comes
    // back as an empty stream rather than a 401, so there's no transport
    // error to catch and the bubble would otherwise spin and then finish
    // blank. Bug: chat hung at "0 tokens" forever after a phone ChatGPT
    // login rotated the session (2026-06-15). Setting firstError flips
    // terminalReason to "error"; reporting it renders the message in the
    // bubble so the user knows to reconnect.
    if (isTruncatedEmpty()) {
      const message =
        "The model returned an empty response (no text or tool calls). This usually means your ChatGPT/OpenAI session expired or you signed in on another device — reconnect OpenAI to continue, or switch providers.";
      firstError = { code: "empty_response", message };
      report({ kind: "error", code: "empty_response", message, retryable: false });
    }

    // Tool-call-in-text fallback. Mirror of the rescue path in
    // openai-compat.ts and anthropic.ts. After a few rounds Codex models
    // (gpt-5 / o-series) sometimes drift to emitting the next tool call
    // as raw JSON in the text channel — `{"name": "browser", "arguments":
    // {...}}` — instead of as a structured function_call. Without this,
    // the JSON shows up in chat, no tool dispatches, the loop stalls.
    // Live failure: user-reported "codex takes 6 turns and stops with
    // JSON in chat" — that's this regression: the model holds wire shape
    // for several turns, then text-flips. Fires ONLY when no structured
    // tool_call arrived this turn AND the text matches a clear pattern.
    if (toolCallIds.length === 0 && assembledText.length > 0) {
      const validNames = new Set(input.tools.map(t => t.name));
      const extracted = extractToolCallsFromText(assembledText, validNames);
      if (extracted.toolCalls.length > 0) {
        logger.info(`${req.model} emitted ${extracted.toolCalls.length} tool call(s) as text — extracted`);
        for (const tc of extracted.toolCalls) {
          toolCallIds.push(tc.id);
          pendingToolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
          report({
            kind: "tool_call_requested",
            call: { toolCallId: tc.id, tool: tc.name, args: parseArgs(tc.arguments) },
          });
        }
        assembledText = extracted.remainingText;
        report({ kind: "stream_redact", replacementText: extracted.remainingText });
      }
    }

    // Finalize an assistant message whenever there is EITHER text OR tool
    // calls. Earlier this only fired on text, dropping tool-only turns —
    // which broke the next turn's tool_result chain on Codex (the API
    // requires the matching function_call item to appear before its
    // function_call_output).
    if (assembledText.length > 0 || pendingToolCalls.length > 0) {
      finalizedMessageId = `cm-${input.opId}-${input.turnIdx}-${Date.now().toString(36)}`;
      const content: { text: string; toolCalls?: typeof pendingToolCalls } = {
        text: assembledText,
      };
      if (pendingToolCalls.length > 0) content.toolCalls = pendingToolCalls;
      const msg: CanonicalMessage = {
        messageId: finalizedMessageId,
        role: "assistant",
        content,
      };
      report({ kind: "message_finalized", message: msg });
    }

    let terminalReason: "done" | "error" | undefined;
    if (this.aborted) {
      terminalReason = "error";
    } else if (interruptedByInject) {
      // Stream cut short by mid-turn user inject. terminalReason='done' so
      // the worker sees hasInjects=true and continues to the next iteration
      // where drainInjectsIntoTurn surfaces the inject text.
      terminalReason = "done";
    } else if (firstError) {
      terminalReason = "error";
    } else if (toolCallIds.length > 0) {
      terminalReason = undefined;
    } else {
      terminalReason = "done";
    }

    let providerState = this.buildProviderState(input, {
      finalizedMessageId,
      stopReason: providerStop,
      pendingTools: toolCallIds.length,
      // model is surfaced for soak-metrics' cost lookup (getPricing).
      model: this.opts.model ?? "gpt-5.4-mini",
      // Codex CLI surfaces usage as a separate event before `done`;
      // the transport buffers + attaches it. Skip when absent so we
      // don't pollute soak with spurious zeros.
      ...(usageInputTokens !== undefined ? { usageInputTokens } : {}),
      ...(usageOutputTokens !== undefined ? { usageOutputTokens } : {}),
    }, newResponseId);

    const sizeCheck = this.checkProviderStateSize(providerState);
    if (sizeCheck) {
      report({ kind: "error", code: "provider_state_oversize", message: sizeCheck, retryable: false });
      providerState = {
        adapterName: CODEX_ADAPTER_NAME,
        adapterVersion: CODEX_ADAPTER_VERSION,
        providerPayload: { error: "provider_state_oversize" },
      };
      terminalReason = "error";
    }

    // Real terminal signal — the model's stop_reason, normalized. See
    // model-stop.ts; decide-outcome trusts it over the shape inference.
    return { providerState, terminalReason, modelStop: classifyModelStop(providerStop) };
  }

  async abort(reason?: unknown): Promise<void> {
    this.aborted = true;
    try { this.aborter.abort(reason); } catch { /* ignore */ }
    if (this.inflight) { try { await this.inflight; } catch { /* swallow */ } }
  }

  private buildProviderState(
    input: TurnInput,
    payload: Record<string, unknown>,
    responseId: string | undefined,
  ): ProviderStateEnvelope {
    return {
      adapterName: CODEX_ADAPTER_NAME,
      adapterVersion: CODEX_ADAPTER_VERSION,
      providerPayload: {
        lastTurnIdx: input.turnIdx,
        ...(responseId ? { previousResponseId: responseId } : {}),
        ...payload,
      },
    };
  }

  private checkProviderStateSize(env: ProviderStateEnvelope): string | null {
    const max = this.opts.providerStateMaxBytes ?? CODEX_PROVIDER_STATE_MAX_BYTES;
    const size = byteLengthUtf8(JSON.stringify(env));
    return size > max ? `provider_state size ${size} bytes exceeds cap ${max}` : null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────
// CanonicalMessage[] → TransportMessage[] conversion lives in the shared
// canonicalToTransport helper. Adapters are expected to import it instead
// of rolling their own — see canonical-to-transport.ts for the contract.

import type { TransportTool } from "./anthropic.js";

function convertTools(tools: TurnInput["tools"]): TransportTool[] {
  return tools.map(t => ({ name: t.name, description: t.description ?? "", parameters: ((t.inputSchema as Record<string, unknown>) ?? {}) }));
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

export function createCodexAdapter(opts: CodexAdapterOptions = {}): CodexAdapter {
  return new CodexAdapter(opts);
}
