/**
 * Batched LLM topical-relevance gate. Replaces the per-signal
 * `signalTopicallyRelevant(messageWords, signalText)` regex check inside the
 * orchestrator's bleed guard. The keyword-overlap heuristic shipped real
 * bugs:
 *   - "monetization plan" ↔ "revenue strategy" → zero word overlap → real
 *     signal dropped despite same topic.
 *   - "audit the kraken project" ↔ prior "audit the open-memory project"
 *     → both share `audit` + `project` → totally unrelated context bled in.
 *   - 3-char tokens (API, SDK) filtered out by length minimum, losing the
 *     most distinctive vocabulary.
 *
 * One LLM call per turn covers all candidate signals; cheaper than N regex
 * passes once the call cost is amortized.
 *
 * Falls back gracefully: if the LLM call fails or the response is unparseable
 * the caller should keep the regex result. This module returns a Set of
 * indices judged relevant; null on failure.
 */

import { classifyJson } from "./classify-with-llm.js";

const SYSTEM_PROMPT = `You are a relevance gate for a chat agent's memory system. Decide which prior-memory signals are TOPICALLY relevant to the user's current message.

A signal is RELEVANT only if a reasonable reader would say "yes, this signal is about the same project, person, decision, or topic as the user's current message."

Reject signals that share only generic vocabulary (e.g. both messages contain "project" or "audit" but reference different projects). Same-named entity = relevant. Same generic word but different entity = NOT relevant.

Examples:
- User: "let's audit the kraken bot fees" + Signal: "auditing the open-memory project chunks" → NOT relevant (different projects, only generic word "audit" overlaps)
- User: "monetization plan for project-x" + Signal: "revenue strategy for project-x" → relevant (same project, synonym words)
- User: "what's in src/index.ts" + Signal: "user prefers light mode" → NOT relevant (entirely different topics)
- User: "API keys for woocommerce" + Signal: "API token issue with the github integration" → NOT relevant (different services, both mention API)

Reply with EXACTLY a single line of JSON in this shape:
{"relevant_indices": [<numbers>]}

Use the 1-based indices given below. If no signals are relevant, reply with {"relevant_indices": []}. No prose, no fences.`;

export interface TopicalGateResult {
  relevantIndices: Set<number>; // 0-based after normalization
}

/**
 * Filter a list of candidate signals by topical relevance to the user's
 * current message. Returns the indices judged relevant (0-based).
 *
 * If the LLM call fails / times out / returns garbage, returns null and the
 * caller should fall back to the regex relevance verdict.
 */
export async function batchedTopicalRelevance(
  userMessage: string,
  signalTexts: string[],
  opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<TopicalGateResult | null> {
  if (signalTexts.length === 0) return { relevantIndices: new Set() };

  const numbered = signalTexts
    .map((s, i) => `${i + 1}. ${s.slice(0, 300)}`)
    .join("\n");

  const userPrompt =
    `User's current message:\n"${userMessage.slice(0, 500)}"\n\n` +
    `Candidate signals from prior memory:\n${numbered}\n\n` +
    `Reply with the JSON object only.`;

  const result = await classifyJson<TopicalGateResult>({
    category: "topical-relevance",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    timeoutMs: opts?.timeoutMs ?? 5000,
    model: opts?.model,
    envDisableVar: "LAX_LLM_TOPICAL_GATE",
    signal: opts?.signal,
    validate: (parsed) => {
      if (!parsed || typeof parsed !== "object") return null;
      const arr = (parsed as { relevant_indices?: unknown }).relevant_indices;
      if (!Array.isArray(arr)) return null;
      const set = new Set<number>();
      for (const v of arr) {
        const n = typeof v === "number" ? v : parseInt(String(v), 10);
        if (Number.isFinite(n) && n >= 1 && n <= signalTexts.length) {
          set.add(n - 1); // convert 1-based → 0-based
        }
      }
      return { relevantIndices: set };
    },
  });

  return result;
}
