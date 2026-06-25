/**
 * LLM second-opinion for the browser-handoff completion gate.
 *
 * Pattern: `browser-handoff.ts` regex (HANDOFF_PATTERNS) catches the obvious
 * give-up phrasings ("you'll need to dismiss the banner", "I'm blocked by the
 * overlay", "can you close that") that mark an interactive turn punting an
 * obstruction back to the user while the page is still open and usable. If it
 * matches, the regex fires the keep-driving nudge. But the regex is brittle:
 *   - It over-fires on a genuine user-only ask the model is RIGHT to make
 *     ("can you log in / give me the 2FA code") — phrased like a handoff but
 *     not a give-up, because only the user can supply a password/code/CAPTCHA.
 *   - It under-fires on novel give-up phrasings outside the pattern list.
 *
 * This wrapper takes the task + the assistant's final message and asks an LLM
 * to judge: did the assistant give up and hand back an obstruction it could
 * clear itself, or did it complete (or hit a genuine user-only blocker)? A
 * later chunk wires this in front of the regex; for now it is a standalone
 * verdict matching the sibling `claim-verify.ts`.
 *
 * Returns:
 *   - `true`  → the assistant gave up / handed an obstruction back (caller
 *     should fire the keep-driving nudge)
 *   - `false` → the assistant completed the task OR hit a genuine user-only
 *     blocker — a password, a 2FA/verification code, a CAPTCHA, private login
 *     credentials (caller should NOT fire the nudge; asking for those is fine)
 *   - `null`  → LLM unavailable / unparseable (caller falls back to its
 *     give-up regex verdict — fail-safe toward the existing behavior)
 */

import { classifyYesNo } from "./classify-with-llm.js";

const SYSTEM_PROMPT = `You are judging whether an AI assistant COMPLETED a browser/computer task or GAVE UP and handed an obstruction back to the user.

Reply YES (gave up) if the assistant stopped short of the goal and is asking the user to do something the assistant could and should do itself from the page/app it already has open — e.g. dismiss a cookie/consent banner, close an overlay, click "accept", scroll, or navigate a public page ("you'll need to dismiss the banner", "I'm blocked by the overlay", "can you close that").

Reply NO (did not give up) if EITHER of these holds:
- The assistant actually completed the task and reported the result, OR
- The assistant is legitimately blocked on something ONLY the user can provide: a password, a 2FA/verification code, a CAPTCHA, or private login credentials. Asking for those is NOT giving up.

Reply with EXACTLY one line starting with YES or NO, followed by a brief reason.`;

export async function classifyGaveUp(
  args: { task: string; finalText: string; signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<boolean | null> {
  const userPrompt =
    `TASK (what the user asked for):\n"${args.task.slice(0, 800)}"\n\n` +
    `ASSISTANT'S FINAL MESSAGE:\n"${args.finalText.slice(0, 2000)}"\n\n` +
    `Did the assistant give up / hand an obstruction back, or did it complete (or hit a genuine user-only blocker)? Reply YES or NO + one-line reason.`;

  return classifyYesNo({
    category: "give-up",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    // Tighter than claim-verify's 4000ms: this verdict gates an INTERACTIVE
    // completion (it decides whether to fire the keep-driving nudge mid-turn),
    // so a slow classifier directly stalls the user-visible reply. Budget it
    // small and fall back to the regex on timeout.
    timeoutMs: args.timeoutMs ?? 2500,
    model: args.model,
    envDisableVar: "LAX_LLM_GIVE_UP_VERIFY",
    signal: args.signal,
  });
}
