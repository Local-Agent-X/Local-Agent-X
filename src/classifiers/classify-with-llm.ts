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
import { resolveProviderContext } from "../providers/resolve-provider-context.js";
import { resolveBackgroundModel } from "../providers/background-model.js";
import { resolveProviderCall } from "./classify-with-llm-dispatch.js";
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
  /**
   * Explicit escape hatch from the "never cross-provider" policy documented
   * above. Every other caller leaves this undefined and gets the existing
   * behavior byte-for-byte: resolveProviderContext() on the user's active
   * chat provider. When set, THIS call alone skips that resolution and runs
   * against the given provider/credential/model instead — for the one
   * deliberately opt-in caller (the regression-audit gate) that a user has
   * explicitly configured a second, independent audit provider for. Never set
   * this to silently route around a provider failure; that is exactly the
   * dark-mode-freeze class of bug this file's policy exists to prevent.
   */
  providerOverride?: { provider: string; apiKey: string; model: string };
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

  let ctx: { provider: string; apiKey: string; model: string } | null;
  if (opts.providerOverride) {
    ctx = opts.providerOverride;
    logger.info(`provider override → ${ctx.provider}`);
  } else {
    ctx = await resolveProviderContext();
  }
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
  const legacyFallbackModel = ctx.model || MODEL_FALLBACKS[provider] || "";
  const explicitModel = opts.model || (opts.modelTier === "active" && ctx.model) || "";
  const background = explicitModel
    ? null
    : await resolveBackgroundModel(provider as ProviderId, legacyFallbackModel);
  let model = explicitModel || background!.model;
  let certifiedLocalTarget = background?.certifiedLocalTarget;
  if (certifiedLocalTarget) {
    const { isCertifiedLocalClassifierTargetCurrent } = await import("../local-runtimes/index.js");
    if (!isCertifiedLocalClassifierTargetCurrent(certifiedLocalTarget)) {
      return null;
    }
  }

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

    // Branch bodies live in classify-with-llm-dispatch.ts (pure extraction,
    // see its header). The result is TAGGED, not a bare nested promise — see
    // that module's header for why a plain `Promise<Promise<T> | null>`
    // return would have silently flattened away the wallclock race below.
    const resolved = await resolveProviderCall({
      provider, apiKey, model,
      systemPrompt: opts.systemPrompt, userPrompt: opts.userPrompt, modelTier: opts.modelTier,
      maxChars, maxTokens, timeoutMs, defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      linkedSignal, certifiedLocalTarget, logger,
    });
    if (resolved.kind === "skip") return null;
    const providerCall = resolved.promise;

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
