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
  `Decide whether the user's most recent message is actually requesting a source-code change right now. ` +
  `self_edit should ONLY run when the user is asking for a code change: a bug fix, a broken behavior to repair, or a missing capability to add.\n\n` +
  `Reply with ONE LINE of JSON, nothing else:\n` +
  `{"verdict": "match" | "mismatch" | "unsure", "reason": "<one short sentence>"}\n\n` +
  `- "match": the user is reporting a bug / broken behavior, or explicitly requesting a code change or new capability, AND the task addresses it ` +
  `(e.g. user "fix the chat freeze" / "the export button does nothing" / "add a transcribe tool" → task patches that area).\n` +
  `- "mismatch": the user is NOT requesting a change. This includes asking a question, making an observation about the agent's own prior action, ` +
  `brainstorming / weighing options, or a task on a different topic. Examples that are mismatch: "i don't see the committed change", ` +
  `"did that actually work?", "is that a bug?", "why did it do that?", "launch the installer" (that's a shell command, not a source edit).\n` +
  `- "unsure": genuinely ambiguous — could plausibly be a change request but you can't tell. We FAIL CLOSED on unsure for this destructive tool, ` +
  `so reserve it for when you're truly torn.`;

// Deterministic backstop for the gate in tool.ts. Catches an explicit "yes,
// go ahead" so a flaky/slow classifier can't strand a real go-ahead — the
// affirmative usually answers a pending offer in the PRIOR assistant turn, so
// the classifier (which scores the task against this short reply) may read it
// as "unsure". Anchored at the start so observations like "i dont see the
// committed change" never match.
const AFFIRMATIVE_GO_AHEAD =
  /^\s*(yes|yep|yeah|yup|ya|sure|ok|okay|k|go|go ahead|do it|please do|go for it|ship it|send it|make it so|proceed|continue|fix it|land it|get it done)\b/i;

export function isAffirmativeGoAhead(msg: string): boolean {
  return AFFIRMATIVE_GO_AHEAD.test(msg.trim());
}

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
