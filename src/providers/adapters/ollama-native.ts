/**
 * Ollama native /api/chat transport — sibling of openai-http.ts with the same
 * stream(ProviderRequest) -> StreamChunk contract, selected for a discovered
 * LOCAL Ollama runtime (canonical-loop/adapters/openai-compat/stream-once.ts).
 * Ollama Cloud, LM Studio, vLLM and every cloud provider stay on /v1.
 *
 * Why native: Ollama's /v1 shim silently drops `options.num_ctx` and
 * `keep_alive` (verified live 2026-07-17 and 2026-08-25; see
 * local-runtimes/ollama-probe.ts), so over /v1 LAX can neither run a model at
 * the context its GPU holds nor keep it loaded. Here every request carries:
 *   options.num_ctx  the context-sizing decision (local-runtimes/
 *                    context-sizing.ts), via the probe's chatExtraBody seam
 *   keep_alive       MODEL_KEEP_ALIVE, the same knob every warm uses
 *   think            the user's thinking depth as this model takes it,
 *                    chosen from the levels the runtime itself reports for
 *                    the model (thinkFor below); nothing for a model
 *                    discovery has not described, so the runtime's default
 *                    applies
 * Same self-heals as openai-http for the rejections Ollama can return here
 * ("does not support tools", "does not support thinking" — server/routes.go
 * ChatHandler lines 2715-2729), one retry each, learned per (baseURL, model)
 * in the store both transports share.
 */
import { BaseAdapter } from "../adapter/base-adapter.js";
import type { ProviderRequest, StreamChunk } from "../adapter/types.js";
import { hasNoToolSupport, markNoToolSupport, hasParamUnsupported, markParamUnsupported } from "../types.js";
import { THINKING_OFF, type WireReasoningEffort } from "../reasoning-effort.js";
import { buildOllamaChatBody } from "./ollama-native-request.js";
import { parseOllamaChatStream } from "./ollama-native-stream.js";
import { ollamaProbe } from "../../local-runtimes/ollama-probe.js";
import { getLocalModel } from "../../local-runtimes/cache.js";
import type { ThinkingSpec } from "../../local-runtimes/types.js";
import { appliedContext } from "../../local-runtimes/context-sizing.js";
import { observeChatResidency, type ReplyDecode } from "../../local-runtimes/context-sizing-adapt.js";
import { MODEL_KEEP_ALIVE } from "../../local-runtimes/residency.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("providers.adapters.ollama-native");

/** The runtime root behind an OpenAI-compat chat base (`<root>/v1`). */
export function ollamaRootOf(baseURL: string | undefined): string {
  return (baseURL ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The depth ladder the picker and Ollama's level names share. Ollama's
 *  "max" (glimmer) sits above xhigh; a name on neither ladder is skipped. */
const DEPTHS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The `think` value for this request: the requested depth as the model's own
 * levels express it (ThinkingSpec, from /api/show via discovery).
 *   - a model that cannot think (`[false]`)        → nothing
 *   - thinking off                                 → false, when it has an off
 *   - a boolean model (`[false, true]`)            → true
 *   - a level model                                → the nearest level it
 *     lists to the requested depth, the higher one on a tie, since a picked
 *     depth is the least the user asked for: qwen3.8 has no "high", so
 *     "high" becomes "xhigh"; gpt-oss has no "xhigh", so that becomes "high"
 *   - no requested depth, or no spec at all        → nothing: the runtime's
 *     own default for the model (undefined), except that off is still off
 */
export function thinkFor(spec: ThinkingSpec | undefined, effort: WireReasoningEffort | undefined): boolean | string | undefined {
  if (!spec) return effort === THINKING_OFF ? false : undefined;
  const levels = spec.values.filter((v): v is string => typeof v === "string");
  if (levels.length === 0 && !spec.values.includes(true)) return undefined;
  if (effort === THINKING_OFF) return spec.values.includes(false) ? false : undefined;
  if (effort === undefined) return undefined;
  if (levels.length === 0) return true;
  const want = DEPTHS.indexOf(effort);
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const level of levels) {
    const at = DEPTHS.indexOf(level);
    if (at < 0) continue;
    const distance = Math.abs(at - want) + (at < want ? 0.5 : 0);
    if (distance < bestDistance) { best = level; bestDistance = distance; }
  }
  return best ?? true;
}

interface Flags { tools: boolean; think: boolean }

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch { /* not JSON: the raw body is the message */ }
  return text || res.statusText;
}

export class OllamaNativeAdapter extends BaseAdapter {
  readonly name = "ollama-native";

  async *stream(req: ProviderRequest): AsyncIterable<StreamChunk> {
    const root = ollamaRootOf(req.baseURL);
    const numCtx = appliedContext(root, req.model);
    // A model that 400'd on think (learned below, shared with /v1's
    // reasoning_effort latch) gets none.
    const think = hasParamUnsupported(req.baseURL, req.model, "reasoning_effort")
      ? undefined
      : thinkFor(getLocalModel(req.baseURL ?? "", req.model)?.thinking, req.reasoningEffort);
    // Exactly the cap the caller decided (local-cap.ts owns it); none → none.
    const numPredict = req.maxTokens;
    const includeFormat = !!req.responseFormat && !hasParamUnsupported(req.baseURL, req.model, "response_format");
    const build = (flags: Flags) => buildOllamaChatBody(req, {
      useTools: flags.tools,
      extraBody: numCtx !== undefined ? ollamaProbe.chatExtraBody(req.model, numCtx) : {},
      think: flags.think ? think : undefined,
      numPredict,
      includeFormat,
      keepAlive: MODEL_KEEP_ALIVE,
    });
    const post = (body: Record<string, unknown>) => fetch(`${root}/api/chat`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        ...(req.apiKey && req.apiKey !== "ollama" ? { Authorization: `Bearer ${req.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    let flags: Flags = { tools: !hasNoToolSupport(req.baseURL, req.model), think: think !== undefined };
    const startedAt = Date.now();
    let body: Record<string, unknown>;
    let res: Response;
    try {
      body = build(flags);
      res = await post(body);
      if (!res.ok) {
        const message = await errorText(res);
        const healed = this.selfHeal(req, flags, message);
        if (!healed) {
          yield { type: "error", message: `${res.status} ${message}`, statusCode: res.status };
          return;
        }
        flags = healed;
        body = build(flags);
        res = await post(body);
        if (!res.ok) {
          yield { type: "error", message: `${res.status} ${await errorText(res)}`, statusCode: res.status };
          return;
        }
      }
    } catch (e) {
      yield { type: "error", message: (e as Error).message || "Ollama stream error" };
      return;
    }

    const { messages: _messages, tools, format, ...rest } = body as Record<string, unknown> & {
      tools?: Array<{ function?: { name?: string } }>;
    };
    yield {
      type: "request_sent",
      params: {
        ...rest,
        ...(tools ? { tools: tools.map((t) => t.function?.name ?? "?") } : {}),
        ...(format ? { format: req.responseFormat?.name ?? "json_schema" } : {}),
      },
    };
    if (!res.body) {
      yield { type: "error", message: "Ollama returned an empty response body" };
      return;
    }
    let completed = false;
    let decode: ReplyDecode | undefined;
    const onDecode = (tokens: number, durationNs: number, contextTokens: number) => { decode = { tokens, durationNs, contextTokens }; };
    try {
      for await (const chunk of parseOllamaChatStream(res.body, { signal: req.signal, startedAt, onDecode })) {
        if (chunk.type === "done") completed = chunk.stopReason !== "abort";
        yield chunk;
      }
    } catch (e) {
      yield { type: "error", message: (e as Error).message || "Ollama stream error" };
      return;
    }
    // A completed request at the applied size is the moment /api/ps can say
    // whether that size stayed on the GPU, and its decode whether the card
    // paged without saying so. Fire-and-forget: never on the turn.
    if (completed && numCtx !== undefined) void observeChatResidency(root, req.model, {}, decode);
  }

  /** The flags to retry with once, or null when the error is not one of ours. */
  private selfHeal(req: ProviderRequest, flags: Flags, message: string): Flags | null {
    if (flags.tools && message.includes("does not support tools")) {
      markNoToolSupport(req.baseURL, req.model);
      logger.info(`model ${req.model} doesn't support tools — switching to chat-only`);
      return { ...flags, tools: false };
    }
    if (flags.think && /does not support thinking|think value/i.test(message)) {
      markParamUnsupported(req.baseURL, req.model, "reasoning_effort");
      logger.info(`model ${req.model} rejected think — retrying without it`);
      return { ...flags, think: false };
    }
    return null;
  }
}

export const ollamaNativeAdapter = new OllamaNativeAdapter();
