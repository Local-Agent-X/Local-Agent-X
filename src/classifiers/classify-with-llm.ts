/**
 * classifyWithLLM — shared abstraction for short-form LLM-as-classifier calls.
 *
 * Pattern: regex (cheap) decides obvious yes/no. Maybe-cases escalate here for
 * an LLM second opinion.
 *
 * **Provider policy (revised 2026-05-06):** uses the user's CURRENTLY-SELECTED
 * provider — whatever they're chatting on — but the provider's BACKGROUND
 * (non-reasoning) model, not their chat model. A yes/no classifier must not
 * burn a flagship reasoner's chain-of-thought: on xAI the chat model grok-4.3
 * reasons by default and timed out EVERY classifier call (2026-06-26), so the
 * give-up verdict silently never ran. backgroundModelFor() drops to the
 * provider's fast tier (registry `backgroundModel`). Still no cross-provider
 * fallback (no Haiku/Sonnet on a Codex turn) — that broke the multi-user-app
 * guarantee and produced the dark-mode-freeze bug (5+ Anthropic-only
 * classifier calls fired on a Codex turn, hanging the UI for tens of seconds
 * after the actual reply finished).
 *
 * Provider routing mirrors `src/memory/curate-classifier.ts`:
 *   - Anthropic (CLI OAuth or API key) → streamAnthropicResponse
 *   - Codex (subscription bearer)      → streamCodexResponse
 *   - OpenAI (API key)                 → llm-dispatch openai
 *   - Ollama / local                   → llm-dispatch ollama
 *   - xAI / Gemini / custom            → null (caller falls back to regex)
 *
 * Reading the active provider: delegated to the shared
 * `resolveProviderContext` helper (src/providers/), the single source of
 * truth for "settings → provider + credential" that the chat seam also
 * routes through. Model defaulting stays here (see MODEL_FALLBACKS) because
 * classifiers deliberately use a cheaper model floor than chat. Each
 * classifier call re-resolves at firing time so a provider switch in the UI
 * takes effect on the next classifier invocation.
 */

import { createLogger } from "../logger.js";
import { getRuntimeConfig } from "../config.js";
import { isModelResident, warmModel } from "../local-runtimes/residency.js";
import { resolveProviderContext } from "../providers/resolve-provider-context.js";
import { resolveBackgroundModel } from "../providers/background-model.js";
import type { ProviderId } from "../providers/provider-ids.js";

// Aggressive default timeout. These classifiers shape signal quality but
// aren't load-bearing — every call site already has a regex/heuristic
// fallback that kicks in on null/error. So the perf budget for each
// classifier should be small. 1.5s = "fast provider returns, slow provider
// gives up gracefully." On Codex the underlying streamCodexResponse may
// have a longer cold-start; abortion via AbortController unblocks the
// caller even if the upstream stream eventually completes in background.
// 8s budget. The Anthropic CLI/OAuth subprocess on Windows is the long
// pole — cold spawn 2-3s + Opus first-byte 1-2s + body 1-2s easily
// crosses 5s. The race is non-blocking on success (resolves on
// first-finish), so this ceiling only adds latency on calls that would
// have failed anyway. With 5s the intent classifier hit wallclock on
// every Anthropic chat turn — observed in soak logs 2026-05-14.
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RESPONSE_CHARS = 800;

// Budgets below this cold-skip a non-resident local model instead of
// dispatching: a cold model load measured 16.5s on this box (2026-07), so a
// shorter wallclock would only burn out waiting for it. At/above 20s the
// caller can sit through the load and still get a real verdict — compaction
// (30s), the scenario judge (20s), and other long-budget callers keep their
// pre-cold-skip behavior (and their call's keep_alive warms the model for
// every short-budget caller that follows).
const COLD_SKIP_MAX_BUDGET_MS = 20_000;

export interface ClassifyOptions<T> {
  /** Logical name for telemetry / env-disable. e.g. "follow-up", "claim-verify". */
  category: string;
  /** Full system prompt. Must instruct the model to reply in the shape `parse` expects. */
  systemPrompt: string;
  /** User-side payload — usually the message + relevant context as a single string. */
  userPrompt: string;
  /** Parser: turn raw model text into T or null on shape mismatch. */
  parse: (raw: string) => T | null;
  /** Hard upper bound (ms). Default 4000. */
  timeoutMs?: number;
  /** Override the model for this classifier. Default: the provider's background (non-reasoning) model. */
  model?: string;
  /**
   * Which tier authors the reply when `model` isn't given. "background"
   * (default) = the provider's fast non-reasoning model — right for yes/no
   * verdicts that must return in seconds. "active" = the user's currently
   * selected chat model — for the rare classifier whose OUTPUT QUALITY is the
   * point (e.g. authoring an acceptance probe), where a reasoning tier is
   * wanted and the call site owns a generous timeout.
   */
  modelTier?: "background" | "active";
  /** Stop reading the stream after this many chars (cheap circuit-break for runaway responses). Default 800. */
  maxResponseChars?: number;
  /** Disable via env var — caller's choice of name (e.g. "LAX_CLAIM_CLASSIFIER"). Set to "0" to skip. */
  envDisableVar?: string;
  /** Optional cancellation. */
  signal?: AbortSignal;
}

/**
 * Per-provider model floor for classifiers when the user has NOT configured
 * an explicit model in settings.json. Classifiers shape signal quality but
 * aren't load-bearing, so they default to a cheaper model than chat (which
 * uses the capable registry default). Only the streaming clients
 * (anthropic/codex) strictly need a value here — `dispatch()` self-defaults
 * the OpenAI-compat providers (openai→gpt-4o-mini, ollama→llama3:8b,
 * xai→grok-4.3), so they're listed for clarity/parity but a "" model reaches
 * the same place. Mirrors the old hand-rolled defaults 1:1.
 */
const MODEL_FALLBACKS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  codex: "gpt-5.5",
  openai: "gpt-4o-mini",
  ollama: "llama3:8b",
  local: "llama3:8b",
};

export async function classifyWithLLM<T>(opts: ClassifyOptions<T>): Promise<T | null> {
  const logger = createLogger(`classifier.${opts.category}`);

  if (opts.envDisableVar && process.env[opts.envDisableVar] === "0") {
    logger.debug(`disabled via ${opts.envDisableVar}=0 — returning null`);
    return null;
  }

  const ctx = await resolveProviderContext();
  if (!ctx) {
    logger.debug(`no provider context (no credentialed provider) — returning null`);
    return null;
  }
  const { provider, apiKey } = ctx;
  // Model precedence: explicit per-call override > tier request > the cheaper
  // floor. "active" = the user's selected chat model (a probe author wants the
  // reasoning tier; the call site owns a long timeout). Default "background"
  // stays on a fast non-reasoning model — a yes/no verdict must not burn a
  // reasoner's chain-of-thought (grok-4.3 EVERY call, 2026-06-26; qwen3.6:27b,
  // 2026-07-15). Never cross-provider. Which model: background-model.ts.
  const model =
    opts.model ||
    (opts.modelTier === "active" && ctx.model) ||
    (await resolveBackgroundModel(provider as ProviderId, ctx.model || MODEL_FALLBACKS[provider] || ""));

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
  // Server-side output budget for the dispatch()-based providers, derived from
  // the same knob as the reader-side cut. The old hard-coded 400 silently
  // TRUNCATED any long-form classifier output (an acceptance probe) mid-line —
  // the reader-side maxResponseChars can't help when the server already cut the
  // stream. ~3 chars/token keeps headroom for code (denser than prose).
  const maxTokens = Math.max(400, Math.ceil(maxChars / 3));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const linkedSignal = opts.signal
    ? linkAbortSignals(opts.signal, ac.signal)
    : ac.signal;

  // Hard wallclock race: wraps every call below in Promise.race against a
  // timeout that resolves with null. We learned (2026-05-06) that the
  // underlying provider clients (especially streamAnthropicResponse via the
  // claude CLI) don't reliably honor AbortController.signal — the await on
  // their async iterator keeps hanging until the upstream process actually
  // ends, which for cold-start CLI spawns can be 30-60 seconds. Without
  // this race, a "1.5s timeout" was actually waiting tens of seconds before
  // returning. The race guarantees the wrapper returns within timeoutMs no
  // matter what the upstream does. The underlying call may still complete
  // in background — we just don't wait for it.
  const RACE_SENTINEL = Symbol("classifier-race-timeout");
  const wallclock = new Promise<typeof RACE_SENTINEL>((resolve) =>
    setTimeout(() => resolve(RACE_SENTINEL), timeoutMs),
  );

  try {
    let response: string | null = null;

    // Per-provider call. Each branch uses the same client the main chat
    // agent uses, so auth automatically just works (CLI OAuth for Anthropic,
    // subscription bearer for Codex, API key for standard OpenAI, localhost
    // for Ollama). xAI/Gemini fall through — caller treats null as "no
    // classifier available" and proceeds with the regex fallback.
    let providerCall: Promise<string | null>;
    if (provider === "anthropic") {
      providerCall = (async () => {
        const { streamAnthropicResponse } = await import("../anthropic-client/index.js");
        const { resolveWrappedDirectToken } = await import("../anthropic-client/oauth-direct.js");
        // Classifier calls take the direct-HTTP path when a subscription token
        // resolves — the shared-CLI warm pool serialized ~8 classifiers/turn and
        // nulled the intent verdict. disableThinking + no tools keep it cheap.
        const token = (await resolveWrappedDirectToken()) ?? apiKey;
        const stream = streamAnthropicResponse({
          token, model,
          messages: [{ role: "user", content: opts.userPrompt } as never],
          systemPrompt: opts.systemPrompt,
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
      })();
    } else if (provider === "codex") {
      providerCall = (async () => {
        const { streamCodexResponse } = await import("../codex-client/index.js");
        const stream = streamCodexResponse({
          token: apiKey, model,
          messages: [{ role: "user", content: opts.userPrompt } as never],
          systemPrompt: opts.systemPrompt,
          tools: [],
          sessionId: undefined,
        });
        let acc = "";
        for await (const event of stream) {
          if (event.type === "text") acc += event.delta || "";
          if (acc.length >= maxChars) break;
        }
        return acc;
      })();
    } else if (provider === "openai") {
      providerCall = (async () => {
        const { dispatch } = await import("../llm-dispatch.js");
        return await dispatch({
          prompt: `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`,
          provider: "openai",
          openaiModel: model,
          temperature: 0, maxTokens, timeoutMs,
        });
      })();
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
      if (timeoutMs < COLD_SKIP_MAX_BUDGET_MS) {
        const ollamaBase = getRuntimeConfig().ollamaUrl.replace(/\/+$/, "");
        const probeMs = Math.min(2000, Math.max(500, Math.floor(timeoutMs / 3)));
        if ((await isModelResident(ollamaBase, model, probeMs)) === false) {
          logger.info(`cold-skip: model not resident (cold or not installed) — background warm attempted (provider=${provider}, model=${model})`);
          warmModel(ollamaBase, model);
          return null;
        }
      }
      providerCall = (async () => {
        const { dispatch } = await import("../llm-dispatch.js");
        return await dispatch({
          prompt: `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`,
          provider: "ollama",
          ollamaModel: model,
          temperature: 0, maxTokens, timeoutMs,
        });
      })();
    } else if (provider === "xai") {
      // Route through dispatch's callXai (api.x.ai/v1 OpenAI-compat endpoint).
      // Without this, every classifier silently returned null for xAI users
      // — identity / affinity / preference auto-capture all bypassed unless
      // the model itself happened to call remember(). Verified May 2026.
      providerCall = (async () => {
        const { dispatch } = await import("../llm-dispatch.js");
        return await dispatch({
          prompt: `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`,
          provider: "xai",
          xaiModel: model,
          temperature: 0, maxTokens, timeoutMs,
        });
      })();
    } else {
      // Gemini / custom — not yet routed through a unified client
      return null;
    }

    // Race the provider call against the wallclock. Whoever finishes first
    // wins. If wallclock wins, we return null and the caller falls back to
    // its regex/heuristic verdict; the actual provider call keeps running
    // in background to completion (it'll eventually resolve and the result
    // is silently discarded — the abort signal still fires, helping the
    // call short-circuit if its provider honors signals).
    const raced = await Promise.race([providerCall, wallclock]);
    if (raced === RACE_SENTINEL) {
      logger.info(`wallclock timeout at ${timeoutMs}ms (provider=${provider})`);
      // Best-effort: drop the orphan promise rejection if the provider call
      // eventually fails. We don't want it to surface as an unhandled rejection.
      providerCall.catch(() => {});
      return null;
    }
    response = raced;

    if (!response || !response.trim()) {
      logger.warn(`empty response`);
      return null;
    }

    const parsed = opts.parse(response);
    if (parsed === null || parsed === undefined) {
      logger.warn(`parse failed: "${response.slice(0, 200)}"`);
      return null;
    }
    return parsed;
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("aborted") || msg.includes("AbortError")) {
      logger.info(`timed out after ${timeoutMs}ms (provider=${provider})`);
    } else {
      logger.warn(`call failed (provider=${provider}): ${msg}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Convenience wrappers (classifyYesNo / parseYesNoReason /
// classifyYesNoWithReason / classifyJson) moved to classify-conveniences.ts —
// this file sat AT the 400-LOC source-hygiene ceiling. Re-exported so existing
// `import { classifyYesNo } from "./classify-with-llm.js"` sites keep working.
export {
  classifyYesNo,
  parseYesNoReason,
  classifyYesNoWithReason,
  classifyJson,
} from "./classify-conveniences.js";

function linkAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (a.aborted || b.aborted) ac.abort();
  else {
    a.addEventListener("abort", onAbort, { once: true });
    b.addEventListener("abort", onAbort, { once: true });
  }
  return ac.signal;
}
