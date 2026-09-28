import { normalizeAnthropicModel } from "../anthropic-models.js";
import { lookupContextWindow } from "./model-windows.js";

/**
 * The BILLING LANE an Anthropic turn actually runs over.
 *
 *  - "cli": the subscription (Max/Pro) lane. Its effective context window is
 *    a property of the subscription, not of the model, and it is only ever
 *    KNOWN from what the lane has been seen to serve (below).
 *  - "api": direct HTTP pay-as-you-go (a real sk-ant-api03 key), which honors
 *    the model's nominal window.
 *
 * NAME IS HISTORICAL. "cli" dates from when subscription credentials could
 * only reach Anthropic through the `claude` subprocess. They now go over
 * direct HTTPS wearing Claude Code's identity (the CLI transport is hidden —
 * see anthropic-client/cli-transport.ts), but the ceiling is a property of the
 * SUBSCRIPTION, so this discriminator still has exactly two meaningful values.
 * Do NOT "fix" this by routing subscription turns to "api": that lifts the
 * ceiling to the nominal 1M for models the lane has never served that wide,
 * and reinstates the un-compactable session death documented below.
 */
export type AnthropicTransport = "api" | "cli";

/**
 * Fallback ceiling for an Anthropic model on the subscription lane that has
 * no measured entry in SUBSCRIPTION_PROVEN_WINDOWS.
 *
 * Soak evidence (op_chat_turn_c6ed855f, ~/lax-soak 2026-07-08): a
 * claude-opus-4-8 session on the subscription path died with a raw provider
 * "prompt is too long" near this size while the 1M-rated window kept every
 * compaction threshold (60/75/90%) permanently unreachable — compaction could
 * never fire on the daily subscription path. Base-200k models are unaffected
 * (the Math.min below is a no-op for them).
 */
export const CLI_EFFECTIVE_WINDOW = 200_000;

/**
 * The largest prompt the subscription lane has DEMONSTRABLY served, per
 * model — rounded down to the thousand below the measurement. This is a
 * floor on the lane's ceiling, not the ceiling itself: a prompt this large was
 * accepted, so compaction thresholds sized against it (60/75/90%) all sit on
 * proven ground. It is deliberately not lifted to the nominal 1M: nothing
 * shows the lane serves that, and an over-sized window is the session death
 * above. Add a row only with an op id whose recorded usage shows the prompt.
 *
 * Evidence: ~/.lax/operations on the owner's box, scanned 2026-09-27
 * (input + cache_read + cache_create of the recorded round; the op's
 * credential source is the subscription — "oauth", or the 2026-09-27 chats
 * that ran on the subscription transport while stamped "env", see commit
 * 24b28575).
 */
export const SUBSCRIPTION_PROVEN_WINDOWS: Record<string, number> = {
  "claude-opus-5": 425_000,   // op_chat_turn_03762399d7564b73: 425,357 tokens, 2026-09-03 (oauth)
  "claude-opus-5-5": 330_000, // op_chat_turn_7d32a0aa14eb41dd: 330,873 tokens, 2026-09-28Z
  "claude-opus-4-8": 276_000, // op_chat_turn_f510bef9d1ea4681: 276,715 tokens, 2026-09-07 (oauth)
};

/**
 * Anthropic (Claude) model — the only family whose effective window depends on
 * transport. Matches the "claude" branch of lookupContextWindow so a model
 * that resolves to an Anthropic window is exactly the one clamped here.
 */
export function isAnthropicModel(model: string): boolean {
  return model.toLowerCase().includes("claude");
}

/** The subscription lane's ceiling for `model`: measured where it has been, the
 *  conservative fallback elsewhere. Aliases (`[1m]`, `anthropic/`, dated
 *  snapshots) resolve to the measured id. */
export function subscriptionWindow(model: string): number {
  return Math.max(CLI_EFFECTIVE_WINDOW, SUBSCRIPTION_PROVEN_WINDOWS[normalizeAnthropicModel(model)] ?? 0);
}

/**
 * The context window to size compaction thresholds and the C1 plausibility
 * clamp against, accounting for transport.
 *
 * For a direct-API turn, or any non-Anthropic model, this equals the nominal
 * window — byte-identical to lookupContextWindow. For an Anthropic model on
 * the subscription lane it is capped at subscriptionWindow(model) so thresholds
 * fire on the window that lane is known to serve.
 *
 * `transport` omitted → nominal window (historical behavior preserved).
 */
export function effectiveContextWindow(model: string, transport?: AnthropicTransport): number {
  const nominal = lookupContextWindow(model);
  if (transport === "cli" && isAnthropicModel(model)) {
    return Math.min(nominal, subscriptionWindow(model));
  }
  return nominal;
}
