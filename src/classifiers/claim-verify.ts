/**
 * LLM second-opinion for action-claim / hallucination guards.
 *
 * Pattern: `agent-guards.ts` regex catches the obvious claim shapes ("I added
 * X", "Saved Y", "Removed Z") and looks up which tool name SHOULD have been
 * called. If no matching tool ran, regex says "hallucination" and we'd fire
 * a retry nudge. But the regex over-fires:
 *   - "I noted in the bash output that..." → 'noted' is a memory verb → fires
 *     a memory_save retry on what was just a recap.
 *   - "I see the issue in commit a4b5c6d7" → '[a-f0-9]{6,16}' matches as
 *     fake Job ID → hallucination nudge fires on a legitimate diagnostic.
 *
 * This wrapper takes the regex's "claim shape detected" verdict and asks an
 * LLM to confirm: was this genuinely a hallucinated claim, or a recap /
 * narration / instructional reference / quote of someone else?
 *
 * Returns:
 *   - `true` → confirmed hallucination (caller should fire the nudge)
 *   - `false` → false positive (caller should NOT fire the nudge)
 *   - `null` → LLM unavailable / unparseable (caller falls back to regex
 *     verdict, i.e. fires the nudge — fail-safe toward the existing behavior)
 */

import { classifyYesNo } from "./classify-with-llm.js";

const SYSTEM_PROMPT = `You are verifying whether an AI assistant's reply contains a HALLUCINATED action claim — a claim that the assistant performed an action that it did NOT actually perform via a tool call.

A claim is HALLUCINATED if the assistant says it did something concrete (added/saved/scheduled/deleted/sent/created/etc.) when no matching tool was called this turn.

A claim is NOT hallucinated if any of these apply:
- The assistant is recapping or describing what just happened (e.g. tool calls in earlier iterations, prior turns)
- The assistant is quoting the user, instructional content, code, documentation, error messages, or output from a tool
- The assistant is using the verb in a non-action sense (e.g. "I noted in the bash output that..." = remarked, not memory_save)
- The assistant is referencing a real artifact (commit hash, file path, identifier) that exists, not inventing one
- The assistant is offering / asking before doing ("I can save this if you want", "should I create...?")

Reply with EXACTLY one line, starting with YES or NO followed by a brief reason.
YES = confirmed hallucination, fire the nudge.
NO = false positive, do not fire the nudge.`;

export async function verifyClaimHallucinationWithLLM(
  assistantText: string,
  toolsCalledThisTurn: string[],
  opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<boolean | null> {
  const tools = toolsCalledThisTurn.length > 0 ? toolsCalledThisTurn.join(", ") : "(none)";
  const userPrompt =
    `Assistant reply (full text):\n"${assistantText.slice(0, 2500)}"\n\n` +
    `Tools that ACTUALLY ran this turn (across all iterations): ${tools}\n\n` +
    `Decide: did the assistant claim to have performed an action that no listed tool actually performed? Reply with YES or NO + one-line reason.`;

  return classifyYesNo({
    category: "claim-verify",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    timeoutMs: opts?.timeoutMs ?? 4000,
    model: opts?.model,
    envDisableVar: "LAX_LLM_CLAIM_VERIFY",
    signal: opts?.signal,
  });
}

const ATTRIBUTION_SYSTEM_PROMPT = `You are verifying whether an AI assistant's reply CONFABULATES an attribution — crediting the result it produced with a tool, model, service, or capability it did NOT actually use this turn.

It IS a confabulated attribution when the assistant says its result "combines", "uses", "is powered by", "is built with", "is in the style of", or "leverages" a named tool / model / service / product that is NOT among the tools it actually used and that it plainly did not use — e.g. crediting a static slide deck with a VIDEO-GENERATION model, or saying an artifact "combines" several products that were only DISCUSSED earlier in the conversation, not used to build it.

It is NOT a confabulation if any of these apply:
- It accurately describes the tools it really used (the ones listed below) or the real sources/data it pulled.
- It is an ordinary aesthetic or content description ("a clean minimalist layout", "a 1950s-poster look", "warm tones") that does not credit a specific external tool/service it didn't use.
- It is offering or proposing ("I could also use X if you want"), not claiming X was used.
- The named thing genuinely WAS used (it is in the actual tools list, or is the real model/provider that produced the output).

Reply with EXACTLY one line, starting with YES or NO followed by a brief reason.
YES = confirmed confabulated attribution, fire the nudge.
NO = accurate or merely aesthetic, do not fire.`;

/**
 * Sibling of {@link verifyClaimHallucinationWithLLM}: that one checks "did the
 * action you CLAIMED happen"; this checks "did the result you produced actually
 * USE the tools/sources you credit it with". Same model-graded plumbing; the
 * caller (attribution-claim middleware) fires only on a confirmed `true` — a
 * downed verifier (`null`) must NOT nag, because the phrase gate alone is too
 * weak to stand on (unlike the action-claim regex).
 */
export async function verifyAttributionConfabulationWithLLM(
  assistantText: string,
  toolsCalledThisTurn: string[],
  opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<boolean | null> {
  const tools = toolsCalledThisTurn.length > 0 ? toolsCalledThisTurn.join(", ") : "(none)";
  const userPrompt =
    `Assistant reply (full text):\n"${assistantText.slice(0, 2500)}"\n\n` +
    `Tools the assistant ACTUALLY used this turn (across all iterations): ${tools}\n\n` +
    `Decide: does the reply credit the result with a tool, model, service, or capability it did NOT actually use? Reply with YES or NO + one-line reason.`;

  return classifyYesNo({
    category: "attribution-verify",
    systemPrompt: ATTRIBUTION_SYSTEM_PROMPT,
    userPrompt,
    timeoutMs: opts?.timeoutMs ?? 4000,
    model: opts?.model,
    envDisableVar: "LAX_LLM_ATTRIBUTION_VERIFY",
    signal: opts?.signal,
  });
}
