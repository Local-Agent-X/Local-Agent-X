/**
 * classifyWithLLM — shared abstraction for short-form LLM-as-classifier calls.
 *
 * Pattern: regex (cheap) decides obvious yes/no. Maybe-cases escalate here for
 * an LLM second opinion.
 *
 * **Provider policy (revised 2026-05-06):** uses the user's CURRENTLY-SELECTED
 * provider and model — whatever they're chatting on. No more Haiku/Sonnet
 * fallback to Anthropic when the user is on Codex; that broke the multi-user-
 * app guarantee and produced the dark-mode-freeze bug (5+ Anthropic-only
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
 * Reading the active provider: settings.json's `provider` field +
 * resolveProvider's auth getter for that provider. Each classifier call
 * looks this up at firing time so a provider switch in the UI takes effect
 * on the next classifier invocation.
 */

import { createLogger } from "../logger.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";

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
  /** Override the default model for this classifier. Default `claude-sonnet-4-6`. */
  model?: string;
  /** Stop reading the stream after this many chars (cheap circuit-break for runaway responses). Default 800. */
  maxResponseChars?: number;
  /** Disable via env var — caller's choice of name (e.g. "LAX_CLAIM_CLASSIFIER"). Set to "0" to skip. */
  envDisableVar?: string;
  /** Optional cancellation. */
  signal?: AbortSignal;
}

/**
 * Read the user's currently-selected provider + model + apiKey, using the
 * same logic the chat path uses. Returns null if no usable provider is
 * configured or auth is unavailable. Cached per call (re-reads settings on
 * every invocation — provider switches take effect immediately).
 */
async function resolveActiveProvider(): Promise<{
  provider: string; model: string; apiKey: string;
} | null> {
  // 1. Read the user's active provider choice from settings.json
  let provider = "anthropic";
  let model = "";
  try {
    const settingsPath = join(getLaxDir(), "settings.json");
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
        provider?: string; model?: string;
      };
      if (s.provider) provider = String(s.provider).toLowerCase();
      if (s.model) model = String(s.model);
    }
  } catch { /* fall through to defaults */ }

  // 2. Resolve apiKey using the same per-provider getters resolveProvider uses
  let apiKey = "";
  try {
    if (provider === "anthropic") {
      const { loadAnthropicTokens, isAnthropicTokenExpired } = await import("../auth-anthropic.js");
      const tokens = loadAnthropicTokens();
      if (!tokens || isAnthropicTokenExpired(tokens)) return null;
      apiKey = tokens.accessToken || "";
      if (!model) model = "claude-sonnet-4-6";
    } else if (provider === "codex") {
      // Subscription bearer via the canonical loader the chat path uses
      // (auth.ts → loadTokens → ChatGPT OAuth). Returns the JWT
      // streamCodexResponse expects. Reading just OPENAI_API_KEY broke
      // every classifier for Codex CLI subscribers (no API key exists).
      try {
        const { getApiKey } = await import("../auth.js");
        apiKey = await getApiKey();
      } catch { /* no subscription tokens — fall through to null below */ }
      if (!model) model = "gpt-5.5";
    } else if (provider === "openai") {
      try {
        const { getSecretsStoreSingleton } = await import("../secrets.js");
        apiKey = getSecretsStoreSingleton()?.get("OPENAI_API_KEY") || "";
      } catch {}
      if (!apiKey) {
        try { apiKey = process.env.OPENAI_API_KEY || ""; } catch {}
      }
      if (!model) model = "gpt-4o-mini";
    } else if (provider === "ollama" || provider === "local") {
      apiKey = "ollama";
      if (!model) model = "llama3:8b";
    } else if (provider === "xai") {
      try {
        const { getSecretsStoreSingleton } = await import("../secrets.js");
        apiKey = getSecretsStoreSingleton()?.get("XAI_API_KEY") || "";
      } catch {}
    } else if (provider === "gemini") {
      try {
        const { getSecretsStoreSingleton } = await import("../secrets.js");
        apiKey = getSecretsStoreSingleton()?.get("GEMINI_API_KEY") || "";
      } catch {}
    }
  } catch { /* fall through */ }

  if (!apiKey) return null;
  return { provider, model, apiKey };
}

export async function classifyWithLLM<T>(opts: ClassifyOptions<T>): Promise<T | null> {
  const logger = createLogger(`classifier.${opts.category}`);

  if (opts.envDisableVar && process.env[opts.envDisableVar] === "0") return null;

  const ctx = await resolveActiveProvider();
  if (!ctx) return null;
  const { provider, model: defaultModel, apiKey } = ctx;
  // Caller can override the model, but otherwise we use whatever the
  // resolved provider's default is (matches what chat uses).
  const model = opts.model ?? defaultModel;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;

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
        const stream = streamAnthropicResponse({
          token: apiKey, model,
          messages: [{ role: "user", content: opts.userPrompt } as never],
          systemPrompt: opts.systemPrompt,
          temperature: 0,
          signal: linkedSignal,
        });
        let acc = "";
        for await (const event of stream) {
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
          temperature: 0, maxTokens: 400, timeoutMs,
        });
      })();
    } else if (provider === "ollama" || provider === "local") {
      providerCall = (async () => {
        const { dispatch } = await import("../llm-dispatch.js");
        return await dispatch({
          prompt: `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`,
          provider: "ollama",
          ollamaModel: model,
          temperature: 0, maxTokens: 400, timeoutMs,
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
          temperature: 0, maxTokens: 400, timeoutMs,
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

/**
 * Convenience: yes/no classifier. Caller's prompt should ask the model to
 * reply with YES or NO on the first line. Returns boolean or null on failure.
 */
export async function classifyYesNo(args: {
  category: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  model?: string;
  envDisableVar?: string;
  signal?: AbortSignal;
}): Promise<boolean | null> {
  return classifyWithLLM<boolean>({
    ...args,
    parse: (raw) => {
      const m = raw.trim().match(/^\s*(YES|NO)\b/i);
      if (!m) return null;
      return m[1].toUpperCase() === "YES";
    },
  });
}

/**
 * Convenience: classifier that returns parsed JSON. Strips the common
 * markdown-fence wrap models sometimes emit even when told not to.
 */
export async function classifyJson<T>(args: {
  category: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs?: number;
  model?: string;
  maxResponseChars?: number;
  envDisableVar?: string;
  signal?: AbortSignal;
  /** Optional shape validator. Return T to accept, null to reject. Defaults to accept-as-is. */
  validate?: (parsed: unknown) => T | null;
}): Promise<T | null> {
  return classifyWithLLM<T>({
    ...args,
    parse: (raw) => {
      const cleaned = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();
      try {
        const obj = JSON.parse(cleaned);
        if (args.validate) return args.validate(obj);
        return obj as T;
      } catch {
        return null;
      }
    },
  });
}

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
