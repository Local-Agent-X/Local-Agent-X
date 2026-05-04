/**
 * classifyWithLLM — shared abstraction for short-form LLM-as-classifier calls.
 *
 * Pattern: regex (cheap) decides obvious yes/no. Maybe-cases escalate here for
 * an LLM second opinion. Mirrors the shape of routing/llm-classifier.ts and
 * memory/curate-classifier.ts so adding new classifiers stops being a copy-
 * paste exercise of auth + timeout + parse + fallback boilerplate.
 *
 * Model policy: defaults to the same Sonnet model the main agent uses. Per
 * project decision (May 2026), we don't downgrade classifiers to Haiku — the
 * cost delta isn't worth the model-switching tech debt across updates.
 *
 * Auth: routes through the user's Claude CLI OAuth (loadAnthropicTokens).
 * If the user isn't signed into Anthropic, returns null and the caller falls
 * back to its regex verdict.
 */

import { createLogger } from "../logger.js";
import { loadAnthropicTokens, isAnthropicTokenExpired } from "../auth-anthropic.js";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_TIMEOUT_MS = 4000;
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

export async function classifyWithLLM<T>(opts: ClassifyOptions<T>): Promise<T | null> {
  const logger = createLogger(`classifier.${opts.category}`);

  if (opts.envDisableVar && process.env[opts.envDisableVar] === "0") return null;

  const tokens = loadAnthropicTokens();
  if (!tokens || isAnthropicTokenExpired(tokens)) return null;
  const accessToken = tokens.accessToken || "";
  if (!accessToken) return null;

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;
  const model = opts.model ?? DEFAULT_MODEL;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const linkedSignal = opts.signal
    ? linkAbortSignals(opts.signal, ac.signal)
    : ac.signal;

  try {
    const { streamAnthropicResponse } = await import("../anthropic-client.js");
    const stream = streamAnthropicResponse({
      token: accessToken,
      model,
      messages: [{ role: "user", content: opts.userPrompt } as never],
      systemPrompt: opts.systemPrompt,
      temperature: 0,
      signal: linkedSignal,
    });

    let response = "";
    for await (const event of stream) {
      if (event.type === "text") response += event.delta || "";
      if (response.length >= maxChars) break;
    }

    if (!response.trim()) {
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
      logger.info(`timed out after ${timeoutMs}ms`);
    } else {
      logger.warn(`call failed: ${msg}`);
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
