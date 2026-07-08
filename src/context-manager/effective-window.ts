import { lookupContextWindow } from "./model-windows.js";

/**
 * The transport an Anthropic turn actually runs over.
 *
 *  - "cli": the Claude CLI/OAuth subprocess proxy — the only route Anthropic
 *    permits for subscription (Max/Pro) credentials. It serves a far smaller
 *    EFFECTIVE context window than the Messages API rates the model at:
 *    empirically ~200k even for models the API bills at 1M.
 *  - "api": direct HTTP pay-as-you-go (a real sk-ant-api03 key), which honors
 *    the model's nominal window.
 *
 * The split mirrors anthropic-client/stream.ts, where the resolved token's
 * shape (the "cli" sentinel / an `oauth:` bearer / an `sk-ant-oat` token vs a
 * real key) decides which stream path runs. See resolve-transport.ts.
 */
export type AnthropicTransport = "api" | "cli";

/**
 * Effective context ceiling for the Anthropic CLI/OAuth subprocess path,
 * regardless of the model's API-rated window.
 *
 * Soak evidence (op_chat_turn_c6ed855f, ~/lax-soak 2026-07-08): a
 * claude-opus-4-8 session on the subscription path died with a raw provider
 * "prompt is too long" near this size while the 1M-rated window kept every
 * compaction threshold (60/75/90%) permanently unreachable — compaction could
 * never fire on the daily subscription path. Base-200k models are unaffected
 * (the Math.min below is a no-op for them); only the 1M-rated ids
 * (opus-4-7/4-8, fable-5, sonnet-5) are clamped here.
 */
export const CLI_EFFECTIVE_WINDOW = 200_000;

/**
 * Anthropic (Claude) model — the only family whose effective window depends on
 * transport. Matches the "claude" branch of lookupContextWindow so a model
 * that resolves to an Anthropic window is exactly the one clamped here.
 */
export function isAnthropicModel(model: string): boolean {
  return model.toLowerCase().includes("claude");
}

/**
 * The context window to size compaction thresholds and the C1 plausibility
 * clamp against, accounting for transport.
 *
 * For a direct-API turn, or any non-Anthropic model, this equals the nominal
 * window — byte-identical to lookupContextWindow. For an Anthropic model on
 * the CLI/OAuth path it is capped at CLI_EFFECTIVE_WINDOW so thresholds fire
 * on the window the daily subscription path actually serves.
 *
 * `transport` omitted → nominal window (historical behavior preserved).
 */
export function effectiveContextWindow(model: string, transport?: AnthropicTransport): number {
  const nominal = lookupContextWindow(model);
  if (transport === "cli" && isAnthropicModel(model)) {
    return Math.min(nominal, CLI_EFFECTIVE_WINDOW);
  }
  return nominal;
}
