/**
 * LLM second-opinion for the profile contradiction sweep.
 *
 * Pattern: `memory/contradiction-sweep.ts` findContradictions flags bullet
 * pairs by polarity regex (hasNegation) + token overlap, and the profile save
 * path DELETES the losing bullet from USER.md/HEART.md/IDENTITY.md — a durable
 * standing-order removed on a heuristic. The regex is deliberately narrow but
 * still semantic-blind: "no preference set" reads as negation, "switched away
 * from Spanish greetings" doesn't, and 0.4 token overlap can pair rules that
 * merely share a topic word.
 *
 * This wrapper vets one flagged pair: do these two rules genuinely contradict
 * (they cannot both be active guidance), or are they compatible?
 *
 * Returns:
 *   - `true`  → genuine contradiction (caller proceeds with the drop)
 *   - `false` → false pair (caller keeps BOTH bullets — THE FIX)
 *   - `null`  → LLM unavailable/timeout/disabled (caller proceeds with the
 *     drop — fail-open to the regex verdict, the pre-existing behavior)
 */

import { classifyYesNo } from "./classify-with-llm.js";

const SYSTEM_PROMPT = `You are auditing an automatic contradiction detector that wants to DELETE one of two rules from a user's durable preference profile. The detector matches on negation words plus word overlap, and it over-fires: rules that merely share a topic word, or where the "negation" is incidental ("no preference set", "not sure yet"), are NOT contradictions.

Two rules genuinely contradict only when they cannot both be active guidance at once — same subject, same behavior, incompatible directives (e.g. "Always greet in Spanish" vs "No Spanish greetings"). Different topics, different scopes, or a past-tense statement coexisting with a present rule are compatible.

Reply with EXACTLY one line starting with YES (genuine contradiction — safe to delete the superseded rule) or NO (compatible — keep both), followed by a brief reason.`;

export async function confirmContradictionPair(
  args: { keepText: string; dropText: string; signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<boolean | null> {
  const userPrompt =
    `RULE THE DETECTOR WANTS TO KEEP:\n"${args.keepText.trim().slice(0, 400)}"\n\n` +
    `RULE THE DETECTOR WANTS TO DELETE:\n"${args.dropText.trim().slice(0, 400)}"\n\n` +
    `Do these genuinely contradict (cannot both be active guidance)? YES or NO + one-line reason.`;

  return classifyYesNo({
    category: "contradiction-confirm",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    // Profile saves happen at end-of-turn / tool time, not mid-stream; pairs
    // are rare (usually 0, occasionally 1). Default budget is fine.
    timeoutMs: args.timeoutMs,
    model: args.model,
    envDisableVar: "LAX_LLM_CONTRADICTION_CONFIRM",
    signal: args.signal,
  });
}
