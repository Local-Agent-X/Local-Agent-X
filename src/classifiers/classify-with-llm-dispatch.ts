/**
 * Per-provider dispatch for classifyWithLLM — pure extraction, split out of
 * classify-with-llm.ts when providerOverride pushed it over the hard 400-LOC
 * source-hygiene ceiling (scripts/check-source-hygiene.mjs). classify-with-llm.ts
 * keeps ownership of the options contract, provider/model resolution, the
 * wallclock race, and the try/catch/finally shape; this module owns ONLY "given
 * a resolved {provider, apiKey, model}, how do we actually call it" — the same
 * five branches (anthropic / codex / openai / ollama-or-local / xai), same
 * bodies, same comments, unchanged.
 *
 * Contract: resolveProviderCall is awaited ONCE by the caller and returns a
 * TAGGED result, not a bare Promise — `{ kind: "call", promise }` for the
 * caller to race against its wallclock timeout exactly as before, or
 * `{ kind: "skip" }` when no call happened (an unsupported provider, or a
 * local cold-skip that already kicked a background warm). A bare
 * `Promise<Promise<string|null> | null>` return type looks equivalent but
 * ISN'T: `await` transparently flattens nested promises (Promise/A+), so
 * `await resolveProviderCall(...)` would silently await the INNER call to
 * completion too — exactly the wallclock race this whole module exists to
 * avoid. The tagged object is not itself thenable, so it survives the await
 * unflattened.
 */
import { getRuntimeConfig } from "../config.js";
import { isModelResident, warmModel } from "../local-runtimes/residency.js";
import { DISPATCH_NUM_CTX } from "../llm-dispatch/ollama.js";
import type { Logger } from "../logger.js";

// Budgets below this cold-skip a non-resident local model instead of
// dispatching: a cold model load measured 16.5s on this box (2026-07), so a
// shorter wallclock would only burn out waiting for it. At/above 20s the
// caller can sit through the load and still get a real verdict — compaction
// (30s), the scenario judge (20s), and other long-budget callers keep their
// pre-cold-skip behavior (and their call's keep_alive warms the model for
// every short-budget caller that follows). Sole owner now that the per-provider
// branches moved here — classify-with-llm.ts no longer references it.
const COLD_SKIP_MAX_BUDGET_MS = 20_000;

export interface ProviderCallInput {
  provider: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  modelTier?: "background" | "active";
  maxChars: number;
  maxTokens: number;
  timeoutMs: number;
  defaultTimeoutMs: number;
  linkedSignal: AbortSignal;
  certifiedLocalTarget: Awaited<ReturnType<typeof import("../providers/background-model.js").resolveBackgroundModel>>["certifiedLocalTarget"];
  logger: Logger;
}

export type ProviderCallResult =
  | { kind: "call"; promise: Promise<string | null> }
  | { kind: "skip" };

const callResult = (promise: Promise<string | null>): ProviderCallResult => ({ kind: "call", promise });
const SKIP: ProviderCallResult = { kind: "skip" };

export async function resolveProviderCall(input: ProviderCallInput): Promise<ProviderCallResult> {
  const {
    provider, apiKey, model, systemPrompt, userPrompt, modelTier,
    maxChars, maxTokens, timeoutMs, defaultTimeoutMs, linkedSignal, certifiedLocalTarget, logger,
  } = input;

  // Per-provider call. Each branch uses the same client the main chat
  // agent uses, so auth automatically just works (CLI OAuth for Anthropic,
  // subscription bearer for Codex, API key for standard OpenAI, localhost
  // for Ollama). xAI/Gemini fall through — caller treats null as "no
  // classifier available" and proceeds with the regex fallback.
  if (provider === "anthropic") {
    return callResult((async () => {
      const { streamAnthropicResponse } = await import("../anthropic-client/index.js");
      const { resolveWrappedDirectToken } = await import("../anthropic-client/oauth-direct.js");
      // Classifier calls take the direct-HTTP path when a subscription token
      // resolves — the shared-CLI warm pool serialized ~8 classifiers/turn and
      // nulled the intent verdict. disableThinking + no tools keep it cheap.
      const token = (await resolveWrappedDirectToken()) ?? apiKey;
      const stream = streamAnthropicResponse({
        token, model,
        messages: [{ role: "user", content: userPrompt } as never],
        systemPrompt,
        temperature: 0,
        disableThinking: true,
        signal: linkedSignal,
      });
      let acc = "";
      for await (const event of stream) {
        // A transport `error` event (e.g. the Claude CLI reporting
        // "Please run /login" when logged out) means there is NO valid
        // response. Abandon the call so the caller falls back to its
        // regex/heuristic verdict — never treat the error text, or a
        // truncated partial reply, as a real classification. Without this,
        // an auth-error string was accepted as a compaction "summary" and
        // persisted over real message history.
        if (event.type === "error") throw new Error(event.error || "anthropic transport error");
        if (event.type === "text") acc += event.delta || "";
        if (acc.length >= maxChars) break;
      }
      return acc;
    })());
  } else if (provider === "codex") {
    return callResult((async () => {
      const { streamCodexResponse } = await import("../codex-client/index.js");
      // Same abort signal the anthropic branch hands its stream. Without it
      // a classifier that lost the wallclock race (42x `wallclock timeout
      // at 1500..4000ms (provider=codex)` in one night's server.log) left
      // its stream running to completion — a full reasoning pass whose
      // answer had already been discarded, billed against the Plus quota
      // (21x `429 usage_limit_reached` in the same log). streamCodexResponse
      // honors the signal: it cancels the fetch AND the body reader.
      //
      // Effort: the codex client defaults to the chat "medium". For a
      // yes/no verdict on gpt-5.4-mini inside a seconds-long budget that
      // reasoning pass is latency for nothing — and is what pushed those
      // calls past the wallclock in the first place (every evidenced
      // timeout ran on a budget <= DEFAULT_TIMEOUT_MS). "low" is accepted
      // by every gpt-5.x. Two kinds of caller keep the client default:
      // modelTier "active" (the chat model, chosen BECAUSE output quality
      // matters — probe authoring, done-claim audit), and long-budget
      // callers that pass no tier but bought the time for a considered
      // answer — scenario-step-planner 10s, chunk-review-judgment 12s,
      // auto-build-advisor 18s, scenario-judge 20s (throws on unparseable),
      // compaction 30s (its summary is persisted over history). Budget is
      // the only signal those callers give us. (memory/extract.ts calls
      // dispatch() directly and never enters this branch.)
      const stream = streamCodexResponse({
        token: apiKey, model,
        messages: [{ role: "user", content: userPrompt } as never],
        systemPrompt,
        tools: [],
        sessionId: undefined,
        reasoningEffort: modelTier === "active" || timeoutMs > defaultTimeoutMs ? undefined : "low",
        signal: linkedSignal,
      });
      let acc = "";
      for await (const event of stream) {
        if (event.type === "text") acc += event.delta || "";
        if (acc.length >= maxChars) break;
      }
      return acc;
    })());
  } else if (provider === "openai") {
    return callResult((async () => {
      const { dispatch } = await import("../llm-dispatch.js");
      return await dispatch({
        prompt: `${systemPrompt}\n\n---\n\n${userPrompt}`,
        provider: "openai",
        openaiModel: model,
        temperature: 0, maxTokens, timeoutMs,
      });
    })());
  } else if (provider === "ollama" || provider === "local") {
    // Cold-start fast-skip (2026-07): the first local call after idle pays
    // the model cold-load INSIDE our wallclock — 16.5s observed against
    // classifier budgets of 3s, where dispatching a non-resident model can
    // only ever time out. Short-budget callers degrade NOW exactly like
    // the wallclock-timeout path (null → caller's regex fallback) and kick
    // a background keep_alive warm so the next call runs hot. Long-budget
    // callers (>= COLD_SKIP_MAX_BUDGET_MS) can afford the load and proceed
    // as they always did. Residency unknown (unreachable / older runtime)
    // → proceed as before; the probe itself gets only a slice of the
    // budget so a hung /api/ps can never eat a sub-2s wallclock.
    const ollamaBase = certifiedLocalTarget?.kind === "ollama"
      ? certifiedLocalTarget.endpointBaseUrl.replace(/\/+$/, "")
      : getRuntimeConfig().ollamaUrl.replace(/\/+$/, "");
    if (timeoutMs < COLD_SKIP_MAX_BUDGET_MS
      && (!certifiedLocalTarget || certifiedLocalTarget.kind === "ollama")) {
      const probeMs = Math.min(2000, Math.max(500, Math.floor(timeoutMs / 3)));
      const exactRedirect = certifiedLocalTarget?.kind === "ollama" ? "manual" : undefined;
      const resident = exactRedirect
        ? await isModelResident(ollamaBase, model, probeMs, exactRedirect)
        : await isModelResident(ollamaBase, model, probeMs);
      if (resident === false) {
        logger.info(`cold-skip: model not resident (cold or not installed) — background warm attempted (provider=${provider}, model=${model})`);
        // Warm at the dispatch window, not Ollama's auto default: the warm
        // fixes the loaded KV size, and the real call that follows uses
        // DISPATCH_NUM_CTX — a default-window warm would pin 8x the VRAM.
        if (exactRedirect) warmModel(ollamaBase, model, exactRedirect, DISPATCH_NUM_CTX);
        else warmModel(ollamaBase, model, undefined, DISPATCH_NUM_CTX);
        return SKIP;
      }
    }
    return callResult((async () => {
      const { dispatch } = await import("../llm-dispatch.js");
      return await dispatch({
        prompt: `${systemPrompt}\n\n---\n\n${userPrompt}`,
        provider: certifiedLocalTarget ? "local" : "ollama",
        ollamaModel: model,
        ...(certifiedLocalTarget
          ? { localTarget: { ...certifiedLocalTarget, apiKey } }
          : {}),
        temperature: 0, maxTokens, timeoutMs,
      });
    })());
  } else if (provider === "xai") {
    // Route through dispatch's callXai (api.x.ai/v1 OpenAI-compat endpoint).
    // Without this, every classifier silently returned null for xAI users
    // — identity / affinity / preference auto-capture all bypassed unless
    // the model itself happened to call remember(). Verified May 2026.
    return callResult((async () => {
      const { dispatch } = await import("../llm-dispatch.js");
      return await dispatch({
        prompt: `${systemPrompt}\n\n---\n\n${userPrompt}`,
        provider: "xai",
        xaiModel: model,
        temperature: 0, maxTokens, timeoutMs,
      });
    })());
  }
  // Gemini / custom — not yet routed through a unified client
  return SKIP;
}
