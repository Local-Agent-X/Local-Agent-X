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
 *   think            what reasoning_effort meant on /v1: false for "none", a
 *                    level for a model whose depth is dial-able, else true
 * Same self-heals as openai-http for the rejections Ollama can return here
 * ("does not support tools", "does not support thinking" — server/routes.go
 * ChatHandler lines 2715-2729), one retry each, learned per (baseURL, model)
 * in the store both transports share.
 */
import { BaseAdapter } from "../adapter/base-adapter.js";
import { LOCAL_DEFAULT_MAX_TOKENS, type ProviderRequest, type StreamChunk } from "../adapter/types.js";
import { hasNoToolSupport, markNoToolSupport, hasParamUnsupported, markParamUnsupported } from "../types.js";
import { isReasoningCapable, resolveReasoningParam } from "./openai-param-support.js";
import { buildOllamaChatBody } from "./ollama-native-request.js";
import { parseOllamaChatStream } from "./ollama-native-stream.js";
import { isLoopbackOrPrivateUrl } from "../../local-only-policy.js";
import { ollamaProbe } from "../../local-runtimes/ollama-probe.js";
import { appliedContext } from "../../local-runtimes/context-sizing.js";
import { observeChatResidency } from "../../local-runtimes/context-sizing-adapt.js";
import { MODEL_KEEP_ALIVE } from "../../local-runtimes/residency.js";
import { createLogger } from "../../logger.js";

const logger = createLogger("providers.adapters.ollama-native");

/** The runtime root behind an OpenAI-compat chat base (`<root>/v1`). */
export function ollamaRootOf(baseURL: string | undefined): string {
  return (baseURL ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** reasoning_effort's meaning as Ollama's native `think` value. */
export function thinkValue(baseURL: string | undefined, model: string, value: string): boolean | string {
  if (value === "none") return false;
  if (!isReasoningCapable(baseURL, model)) return true;
  return value === "minimal" ? "low" : value;
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
    const reasoning = resolveReasoningParam({ baseURL: req.baseURL, model: req.model, effort: req.reasoningEffort });
    const numPredict = req.maxTokens
      ?? (!req.omitDefaultMaxTokens && isLoopbackOrPrivateUrl(root) ? LOCAL_DEFAULT_MAX_TOKENS : undefined);
    const includeFormat = !!req.responseFormat && !hasParamUnsupported(req.baseURL, req.model, "response_format");
    const build = (flags: Flags) => buildOllamaChatBody(req, {
      useTools: flags.tools,
      extraBody: numCtx !== undefined ? ollamaProbe.chatExtraBody(req.model, numCtx) : {},
      think: flags.think ? thinkValue(req.baseURL, req.model, reasoning.value) : undefined,
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

    let flags: Flags = { tools: !hasNoToolSupport(req.baseURL, req.model), think: reasoning.send };
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
    try {
      for await (const chunk of parseOllamaChatStream(res.body, { signal: req.signal, startedAt })) {
        if (chunk.type === "done") completed = chunk.stopReason !== "abort";
        yield chunk;
      }
    } catch (e) {
      yield { type: "error", message: (e as Error).message || "Ollama stream error" };
      return;
    }
    // A completed request at the applied size is the moment /api/ps can say
    // whether that size stayed on the GPU. Fire-and-forget: never on the turn.
    if (completed && numCtx !== undefined) void observeChatResidency(root, req.model);
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
