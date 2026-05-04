/**
 * LLM follow-up classifier — hybrid escalation for the orchestrator's
 * `isConversationalFollowup` regex which is brittle in the 5-9 word range.
 *
 * Failure cases this fixes:
 *   - "what is webrtc" (3 words) → regex matches `^what\b` → classified
 *     follow-up → recall signals dropped → agent looks confused. But this
 *     IS a substantive new question.
 *   - "and then what" → regex misses → treated as substantive → bleed.
 *   - "tell me more about kraken btw" → "tell me more" pronoun branch fires
 *     → treated as follow-up. Real ask.
 *   - "i love this idea" → `\bthis\b` matches → follow-up. Substantive react.
 *
 * Follow-up-ness is RELATIONAL — it depends on what the assistant just said.
 * The classifier takes both the user's current message and the prior
 * assistant text and makes the call.
 */

import { classifyYesNo } from "./classify-with-llm.js";

const SYSTEM_PROMPT = `You decide whether a user's message is a SHORT CONVERSATIONAL FOLLOW-UP to the assistant's prior turn, vs. a SUBSTANTIVE NEW REQUEST.

A FOLLOW-UP is:
- Acknowledgement, agreement, or short reaction ("yeah", "ok", "thanks", "got it", "sounds good", "no", "lol")
- A question that only makes sense in light of what the assistant just said ("what about that one?", "really?", "wait what", "and then?", "tell me more")
- A pronoun-anchored short reaction without naming a new topic ("i love it", "that's cool", "this is great")

A SUBSTANTIVE NEW REQUEST is:
- Any message that names a new topic / project / file / person / question, even if short
- Standalone questions about something the assistant didn't bring up ("what is webrtc?", "explain X", "build me a Y")
- "Tell me more about <named topic>" — the named topic is the request, not the prior turn
- Reactions that include a new concrete subject ("i love that, but make it blue")

Reply with EXACTLY one line: YES <reason> if FOLLOW-UP, NO <reason> if SUBSTANTIVE.`;

/**
 * Decide whether the user's current message is a conversational follow-up to
 * the prior assistant turn. Returns:
 *   - true → follow-up (caller drops session-scoped signals)
 *   - false → substantive (caller runs normal recall path)
 *   - null → LLM unavailable; caller should keep its regex verdict
 */
export async function classifyFollowupWithLLM(
  userMessage: string,
  priorAssistantText: string | undefined,
  opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<boolean | null> {
  const prior = (priorAssistantText || "").slice(0, 800);
  const userPrompt =
    `Prior assistant message:\n"${prior || "(none — this is the first turn)"}"\n\n` +
    `User's current message:\n"${userMessage.slice(0, 400)}"\n\n` +
    `Reply YES (follow-up) or NO (substantive) + one-line reason.`;

  return classifyYesNo({
    category: "followup",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    timeoutMs: opts?.timeoutMs ?? 3000,
    model: opts?.model,
    envDisableVar: "LAX_LLM_FOLLOWUP",
    signal: opts?.signal,
  });
}
