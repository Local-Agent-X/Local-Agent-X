/**
 * LLM follow-up classifier — relational verdict over the prior assistant turn.
 *
 * Three outcomes:
 *   - "followup" — short ack / pronoun reaction. Drop session-scope signals.
 *     ("yeah", "ok", "really?", "i love it")
 *   - "new"      — substantive new request, regardless of length. Run normal
 *     recall path.  ("what is webrtc", "build me a Y", "tell me more about
 *     <named topic>")
 *   - "resume"   — user is resuming an in-flight task that the agent paused
 *     on (e.g. "agent: please log in" → "user: im logged in go"). Keep
 *     active-task signals, drop competing-task signals — including profile-
 *     scope signals that name unrelated projects. Resume looks like a
 *     follow-up by length but shouldn't drop the active-task signal.
 *
 * Failure cases this fixes:
 *   - "what is webrtc" (3 words) → regex matches `^what\b` → classified
 *     follow-up → recall signals dropped → agent looks confused.
 *   - "im logged in go" → looks like a follow-up → session signals dropped
 *     → agent's profile recall surfaces an unrelated past task ("Sports
 *     Life products pending") and the agent asks "which to finish?"
 *     instead of resuming the in-flight PO entry.
 *
 * Follow-up-ness is RELATIONAL — it depends on what the assistant just said
 * and what task is currently in flight. The classifier takes the user's
 * current message, the prior assistant text, AND the first substantive user
 * message of the session (the active-task anchor).
 */

import { z } from "zod";
import { classifySchema, type ClassifySchemaOptions } from "./schema-output.js";

export type FollowupVerdict = "followup" | "new" | "resume";

const SYSTEM_PROMPT = `You decide how a user's message relates to the conversation. Give one verdict plus a one-line reason.

VERDICTS:
- FOLLOWUP — short ack, agreement, or short reaction tied to what the assistant just said. ("yeah", "ok", "thanks", "got it", "really?", "tell me more", "i love it", "wait what")
- RESUME   — user is continuing an in-flight task the assistant paused on. The prior assistant turn asked the user to do something out of band (log in, click a button, open a page, paste a value), and the user's message says they did it or asks the assistant to keep going. ("im logged in", "go", "continue", "keep going", "ok done", "ready", "now what", "i did it"). The active-task anchor is the user's first substantive request in this session.
- NEW      — substantive new request, even if short. Names a new topic, project, file, person, or question that's unrelated to the in-flight task. ("what is webrtc?", "switch to the kraken bot", "open instagram and give me stats", "build me a Y")

Rules:
- If the prior assistant turn ended with an imperative directed at the user ("please log in", "click X", "paste it here") AND the user's reply is short and acknowledges/continues, that's RESUME, not FOLLOWUP — the active task isn't done.
- If the user's message names a CONCRETE NEW topic distinct from the active-task anchor, that's NEW. Do not classify it as RESUME just because it's short.
- Default to NEW when uncertain — keeping recall is safer than dropping it.`;

// Verdict tokens stay the uppercase prompt vocabulary; the map below converts
// to the lowercase FollowupVerdict the callers switch on. `reason` is
// telemetry-only — optional so a terse reply doesn't void a valid verdict.
const FollowupReplySchema = z.object({
  verdict: z.enum(["FOLLOWUP", "RESUME", "NEW"]),
  reason: z.string().optional(),
});

const VERDICT_MAP: Record<"FOLLOWUP" | "RESUME" | "NEW", FollowupVerdict> = {
  FOLLOWUP: "followup",
  RESUME: "resume",
  NEW: "new",
};

/**
 * Classify the user's current message in relation to the prior turn and the
 * session's active task. Returns:
 *   - "followup" — caller drops session-scope signals (cheap acks)
 *   - "resume"   — caller keeps active-task signals, drops competing
 *   - "new"      — caller runs normal recall path
 *   - null       — LLM unavailable; caller falls back to its regex verdict
 */
export async function classifyFollowupWithLLM(
  userMessage: string,
  priorAssistantText: string | undefined,
  opts?: {
    /** First substantive user message of this session — the active-task
     *  anchor. Helps the classifier tell "resume an in-flight task" from
     *  "ack a finished one." */
    firstUserMessage?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    model?: string;
    _llm?: ClassifySchemaOptions<unknown>["_llm"];
  },
): Promise<FollowupVerdict | null> {
  const prior = (priorAssistantText || "").slice(0, 800);
  const anchor = (opts?.firstUserMessage || "").slice(0, 400);
  const userPrompt =
    `Active-task anchor (first substantive ask this session):\n"${anchor || "(none yet)"}"\n\n` +
    `Prior assistant message:\n"${prior || "(none — this is the first turn)"}"\n\n` +
    `User's current message:\n"${userMessage.slice(0, 400)}"\n\n` +
    `Verdict FOLLOWUP / RESUME / NEW + one-line reason.`;

  const reply = await classifySchema({
    category: "followup",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    schema: FollowupReplySchema,
    shapeHint: `{"verdict":"FOLLOWUP" or "RESUME" or "NEW","reason":"one line"}`,
    timeoutMs: opts?.timeoutMs ?? 3000,
    model: opts?.model,
    envDisableVar: "LAX_LLM_FOLLOWUP",
    signal: opts?.signal,
    _llm: opts?._llm,
  });
  return reply ? VERDICT_MAP[reply.verdict] : null;
}
