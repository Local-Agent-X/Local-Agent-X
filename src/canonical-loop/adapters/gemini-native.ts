/**
 * Gemini native adapter — canonical adapter contract over Google's
 * generateContent API. Structurally mirrors codex.ts / anthropic.ts: convert
 * canonical messages → the shared TransportMessage envelope, hand to the
 * Gemini transport, and report stream/tool/done events back through the
 * contract.
 *
 * Replaces the OpenAI-compat path for Gemini, whose compat shim returns empty
 * STOP completions nondeterministically on tool-laden requests (an unfixable
 * Google bug). Stateless like openai-compat — no Codex-style response-id
 * chaining; each turn re-sends full history.
 */
import type { Adapter, AdapterReport, TurnInput, TurnResult } from "../adapter-contract.js";
import type { CanonicalMessage, ProviderStateEnvelope } from "../contract-types.js";
import type { GeminiNativeTransport, GeminiNativeRequest } from "./gemini-native-transport.js";
import { canonicalToTransport } from "./canonical-to-transport.js";
import { hasInjects } from "../../agent-loop/inject-queue.js";
import { extractToolCallsFromText } from "./tool-call-text-extractor.js";
import { classifyModelStop } from "./model-stop.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("canonical-loop.gemini-native");

export const GEMINI_NATIVE_ADAPTER_NAME = "gemini-native";
export const GEMINI_NATIVE_ADAPTER_VERSION = "1.0.0";
const PROVIDER_STATE_MAX_BYTES = 256 * 1024;

export interface GeminiNativeAdapterOptions {
  transport?: GeminiNativeTransport;
  model: string;
  apiKey: string;
  systemPrompt?: string;
  temperature?: number;
  /** Gemini 2.5/3.x are reasoning models — request thinking when capable. */
  thinking?: boolean;
  sessionId?: string;
  forcedToolChoice?: { type: "tool"; name: string };
}

export class GeminiNativeAdapter implements Adapter {
  readonly name = GEMINI_NATIVE_ADAPTER_NAME;
  readonly version = GEMINI_NATIVE_ADAPTER_VERSION;

  private aborted = false;
  private aborter: AbortController = new AbortController();
  private inflight: Promise<void> | null = null;
  private readonly transportPromise: Promise<GeminiNativeTransport>;

  constructor(private readonly opts: GeminiNativeAdapterOptions) {
    this.transportPromise = opts.transport
      ? Promise.resolve(opts.transport)
      : import("./gemini-native-transport.js").then(m => m.defaultGeminiNativeTransport());
  }

  async runTurn(input: TurnInput, report: (r: AdapterReport) => void): Promise<TurnResult> {
    if (this.aborted) {
      report({ kind: "error", code: "aborted", message: "adapter aborted before runTurn", retryable: false });
      return { providerState: this.buildProviderState(input, {}), terminalReason: "error" };
    }

    this.aborter = new AbortController();
    const transport = await this.transportPromise;
    const forcedToolChoice = input.turnIdx === 0 ? this.opts.forcedToolChoice : undefined;

    let assembledText = "";
    const toolCallIds: string[] = [];
    const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let firstError: { code: string; message: string } | null = null;
    let providerStop: string | undefined;
    let usageInputTokens: number | undefined;
    let usageOutputTokens: number | undefined;
    let interruptedByInject = false;

    const req: GeminiNativeRequest = {
      model: this.opts.model,
      apiKey: this.opts.apiKey,
      systemPrompt: this.opts.systemPrompt ?? "You are a helpful assistant.",
      messages: canonicalToTransport(input.messages, input.pendingRedirect, new Set(input.tools.map(t => t.name))),
      tools: input.tools.map(t => ({ name: t.name, description: t.description ?? "", parameters: (t.inputSchema as Record<string, unknown>) ?? {} })),
      signal: this.aborter.signal,
      temperature: this.opts.temperature,
      thinking: this.opts.thinking,
      forcedToolChoice,
    };

    const consume = async (): Promise<void> => {
      try {
        for await (const ev of transport.stream(req)) {
          if (this.aborted) break;
          if (this.opts.sessionId && hasInjects(this.opts.sessionId)) {
            interruptedByInject = true;
            try { this.aborter?.abort(); } catch { /* already aborted */ }
            break;
          }
          if (ev.type === "thinking") { report({ kind: "heartbeat" }); continue; }
          if (ev.type === "text") {
            if (ev.delta.length === 0) continue;
            assembledText += ev.delta;
            report({ kind: "stream_chunk", body: { delta: ev.delta } });
            continue;
          }
          if (ev.type === "tool_call") {
            toolCallIds.push(ev.id);
            pendingToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
            report({ kind: "tool_call_requested", call: { toolCallId: ev.id, tool: ev.name, args: parseArgs(ev.arguments) } });
            continue;
          }
          if (ev.type === "error") {
            if (!firstError) firstError = { code: ev.code, message: ev.message };
            report({ kind: "error", code: ev.code, message: ev.message, retryable: ev.retryable === true });
            continue;
          }
          if (ev.type === "done") {
            providerStop = ev.stopReason;
            if (ev.usage) { usageInputTokens = ev.usage.inputTokens; usageOutputTokens = ev.usage.outputTokens; }
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

    // Tool-call-in-text fallback — mirror of codex.ts / openai-compat.ts. If a
    // structured functionCall didn't arrive but the text reads like one, rescue
    // it so the JSON doesn't leak to chat and stall the loop.
    if (toolCallIds.length === 0 && assembledText.length > 0) {
      const validNames = new Set(input.tools.map(t => t.name));
      const extracted = extractToolCallsFromText(assembledText, validNames);
      if (extracted.toolCalls.length > 0) {
        logger.info(`${this.opts.model} emitted ${extracted.toolCalls.length} tool call(s) as text — extracted`);
        for (const tc of extracted.toolCalls) {
          toolCallIds.push(tc.id);
          pendingToolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
          report({ kind: "tool_call_requested", call: { toolCallId: tc.id, tool: tc.name, args: parseArgs(tc.arguments) } });
        }
        assembledText = extracted.remainingText;
        report({ kind: "stream_redact", replacementText: extracted.remainingText });
      }
    }

    let finalizedMessageId: string | null = null;
    if (assembledText.length > 0 || pendingToolCalls.length > 0) {
      finalizedMessageId = `cm-${input.opId}-${input.turnIdx}-${Date.now().toString(36)}`;
      const content: { text: string; toolCalls?: typeof pendingToolCalls } = { text: assembledText };
      if (pendingToolCalls.length > 0) content.toolCalls = pendingToolCalls;
      const msg: CanonicalMessage = { messageId: finalizedMessageId, role: "assistant", content };
      report({ kind: "message_finalized", message: msg });
    }

    let terminalReason: "done" | "error" | undefined;
    if (this.aborted) terminalReason = "error";
    else if (interruptedByInject) terminalReason = "done";
    else if (firstError) terminalReason = "error";
    else if (toolCallIds.length > 0) terminalReason = undefined;
    else terminalReason = "done";

    const providerState = this.buildProviderState(input, {
      finalizedMessageId,
      stopReason: providerStop,
      pendingTools: toolCallIds.length,
      model: this.opts.model,
      ...(usageInputTokens !== undefined ? { usageInputTokens } : {}),
      ...(usageOutputTokens !== undefined ? { usageOutputTokens } : {}),
    });

    // Real terminal signal — Gemini's finishReason, normalized. See
    // model-stop.ts; decide-outcome trusts it over the shape inference.
    return { providerState, terminalReason, modelStop: classifyModelStop(providerStop) };
  }

  async abort(reason?: unknown): Promise<void> {
    this.aborted = true;
    try { this.aborter.abort(reason); } catch { /* ignore */ }
    if (this.inflight) { try { await this.inflight; } catch { /* swallow */ } }
  }

  private buildProviderState(input: TurnInput, payload: Record<string, unknown>): ProviderStateEnvelope {
    const env: ProviderStateEnvelope = {
      adapterName: GEMINI_NATIVE_ADAPTER_NAME,
      adapterVersion: GEMINI_NATIVE_ADAPTER_VERSION,
      providerPayload: { lastTurnIdx: input.turnIdx, ...payload },
    };
    if (JSON.stringify(env).length > PROVIDER_STATE_MAX_BYTES) {
      return { adapterName: GEMINI_NATIVE_ADAPTER_NAME, adapterVersion: GEMINI_NATIVE_ADAPTER_VERSION, providerPayload: { error: "provider_state_oversize" } };
    }
    return env;
  }
}

function parseArgs(raw: string): unknown {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

export function createGeminiNativeAdapter(opts: GeminiNativeAdapterOptions): GeminiNativeAdapter {
  return new GeminiNativeAdapter(opts);
}
