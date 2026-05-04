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
