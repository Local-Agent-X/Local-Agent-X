/**
 * Layer 1 — intent gate. Sanity-check the self_edit task against the
 * user's most recent message via a small LLM call on the SAME provider+
 * model the chat is currently using (no provider hardcode → no migration
 * tax when switching models). Returns null on any classifier failure
 * (no creds, timeout, parse error) and the caller fails open.
 *
 * The gate prompt is intentionally narrow: "does the task match the
 * intent?" rather than open-ended. Yes/no/unsure with a one-line
 * reason. Tiny output, fast classification, low chance of weird drift.
 */

import { classifyWithLLM } from "../classifiers/classify-with-llm.js";

const TIMEOUT_MS = 8000;

const SYSTEM_PROMPT =
  `You are a sanity-check classifier for self_edit, a destructive tool that modifies the agent's own source code. ` +
  `Decide if a self_edit task description matches what the user is actually asking for. ` +
  `self_edit should ONLY run when the user wants source-code changes (bug fix, missing capability) related to the chat.\n\n` +
  `Reply with ONE LINE of JSON, nothing else:\n` +
  `{"verdict": "match" | "mismatch" | "unsure", "reason": "<one short sentence>"}\n\n` +
  `- "match": the task addresses the same intent the user expressed (e.g. user asks "fix the chat freeze", task says "fix race in chat-ws.ts where streamingSessionId leaks")\n` +
  `- "mismatch": the task is on a different topic, or solves a problem the user didn't ask about (e.g. user says "launch the installer", task says "edit cron jobs")\n` +
  `- "unsure": ambiguous — task could plausibly relate but you can't tell. Bias toward "unsure" when uncertain; we fail open on unsure.`;

export async function checkSelfEditIntent(
  task: string,
  lastUserMessage: string,
  lastAssistantMessage: string,
): Promise<{ verdict: "match" | "mismatch" | "unsure"; reason: string } | null> {
  const userBlock =
    `User's most recent message:\n"""${lastUserMessage.slice(0, 600)}"""\n\n` +
    (lastAssistantMessage ? `Most recent assistant text:\n"""${lastAssistantMessage.slice(0, 400)}"""\n\n` : "") +
    `self_edit task being submitted:\n"""${task.slice(0, 600)}"""\n\n` +
    `Classify per the system rules. JSON only.`;

  return classifyWithLLM<{ verdict: "match" | "mismatch" | "unsure"; reason: string }>({
    category: "self-edit-intent",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userBlock,
    parse: (raw) => {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        const parsed = JSON.parse(m[0]) as { verdict?: string; reason?: string };
        const v = parsed.verdict;
        if (v !== "match" && v !== "mismatch" && v !== "unsure") return null;
        return { verdict: v, reason: String(parsed.reason || "").slice(0, 200) };
      } catch { return null; }
    },
    timeoutMs: TIMEOUT_MS,
  });
}
