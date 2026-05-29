import type { OrchestratorInput } from "./types.js";
import { getModuleScope } from "./registry.js";
import { isConversationalFollowup, topicalKeywords, signalTopicallyRelevant } from "./topical-helpers.js";

// Three-state verdict from the LLM classifier:
//   "followup" — short ack: drop session-scope signals.
//   "resume"   — user is resuming an in-flight task the agent paused on.
//                Filter ALL signals (profile + session) by topical
//                relevance to the active-task ANCHOR (first substantive
//                user message), not the resume message itself ("go" has
//                no topic words and would let everything through). This
//                is the structural fix for the bug where profile recall
//                of a stale unrelated task ("Sports Life products") got
//                surfaced after the user said "im logged in go" while
//                entering a new PO.
//   "new"      — substantive new ask: normal topical-relevance gate.
export type Verdict = "followup" | "resume" | "new";

// Minimal signal shape consumed by the bleed gate. Kept loose so we don't
// pull in fusion.ts's full Signal type just for filtering.
interface FilterableSignal {
  source: string;
  signal: string;
}

export async function classifyVerdict(input: OrchestratorInput, anchorText: string): Promise<Verdict> {
  const wordCount = input.message.trim().split(/\s+/).length;
  const regexFollowup = isConversationalFollowup(input.message);
  let verdict: Verdict = regexFollowup ? "followup" : "new";

  // Hybrid follow-up detection. Regex is the cheap pre-filter — it gets
  // obvious acks ("ok", "thanks") right and obvious substantive asks
  // ("build me an X") right. The 5-9 word zone is brittle (e.g. "what is
  // webrtc" misclassified as follow-up; "i love this idea" same). For
  // those, escalate to the LLM follow-up classifier which gets BOTH the
  // user message AND the prior assistant turn (relational call).
  if (wordCount >= 3 && wordCount <= 12) {
    try {
      const { classifyFollowupWithLLM } = await import("../classifiers/followup-classify.js");
      const llmVerdict = await classifyFollowupWithLLM(
        input.message,
        input.agentPreviousMessage,
        { firstUserMessage: anchorText },
      );
      if (llmVerdict !== null) verdict = llmVerdict;
    } catch {
      // keep regex verdict on classifier failure
    }
  }
  return verdict;
}

export async function applyBleedGate<S extends FilterableSignal>(
  signals: S[],
  verdict: Verdict,
  input: OrchestratorInput,
  anchorText: string,
): Promise<S[]> {
  if (verdict === "followup") {
    // Phase A — drop session-scope signals on cheap acks. Profile-scope
    // always passes (stable user identity).
    return signals.filter(s => getModuleScope(s.source) === "profile");
  }

  if (verdict === "resume") {
    // Phase A' — resume: gate ALL signals (profile + session) against the
    // active-task anchor, not the resume message. Profile signals about
    // the active task pass through; profile signals about other tasks
    // get dropped. This is what makes "im logged in go" continue the
    // current PO instead of surfacing an unrelated past project.
    try {
      const { batchedTopicalRelevance } = await import("../classifiers/topical-relevance.js");
      const v = await batchedTopicalRelevance(anchorText, signals.map(s => s.signal));
      if (v) {
        return signals.filter((_, i) => v.relevantIndices.has(i));
      }
      const anchorWords = topicalKeywords(anchorText);
      return signals.filter(s => signalTopicallyRelevant(anchorWords, s.signal));
    } catch {
      const anchorWords = topicalKeywords(anchorText);
      return signals.filter(s => signalTopicallyRelevant(anchorWords, s.signal));
    }
  }

  // Phase B — substantive new ask. Profile passes; session-scope is
  // gated by topical relevance to the user's current message.
  const profileSignals = signals.filter(s => getModuleScope(s.source) === "profile");
  const sessionSignals = signals.filter(s => getModuleScope(s.source) !== "profile");

  if (sessionSignals.length === 0) return profileSignals;

  let keptSession = sessionSignals;
  try {
    const { batchedTopicalRelevance } = await import("../classifiers/topical-relevance.js");
    const v = await batchedTopicalRelevance(input.message, sessionSignals.map(s => s.signal));
    if (v) {
      keptSession = sessionSignals.filter((_, i) => v.relevantIndices.has(i));
    } else {
      const messageWords = topicalKeywords(input.message);
      keptSession = sessionSignals.filter(s => signalTopicallyRelevant(messageWords, s.signal));
    }
  } catch {
    const messageWords = topicalKeywords(input.message);
    keptSession = sessionSignals.filter(s => signalTopicallyRelevant(messageWords, s.signal));
  }
  return [...profileSignals, ...keptSession];
}

export function getAnchorText(input: OrchestratorInput): string {
  const firstUserMessage =
    input.sessionMessages.find(m => m.role === "user")?.content ?? input.message;
  return typeof firstUserMessage === "string" ? firstUserMessage : "";
}
