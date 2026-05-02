/**
 * Routing regex rules — ALL patterns that influence the routing decision
 * live here. Single owner. Adding a new pattern means editing exactly
 * this file (plus tests if behavior changes).
 *
 * Rules are evaluated in priority order by `decideByRegex()`:
 *   1. discuss-prefix       (force INLINE — explicit slash command)
 *   2. user-override        (force INLINE — plain-language "don't spawn")
 *   3. discussion-cue       (force INLINE — workshop / brainstorm / opinion)
 *   4. codex-investigative  (force DELEGATE — Codex stalls without isolation)
 *   5. short-task           (force INLINE — < 30 chars or starts with greeting/ack)
 *   6. word-count >= 50     (force DELEGATE — sheer length signals long task)
 *   7. build-noun phrase    (force DELEGATE — "create an app" pattern)
 *   8. long-task verb + ctx (force DELEGATE — "refactor X across multiple files")
 *   9. default              (INLINE — when no rule matched)
 *
 * The model-as-classifier (llm-classifier.ts) runs AFTER this regex layer
 * decides DELEGATE, with veto power. So regex says "yes delegate" → LLM
 * gets a second-opinion → can flip to INLINE if it sees user override
 * the regex missed.
 */

import type { RouteDecision } from "./types.js";

// Long-task verbs. These DON'T trigger delegation alone — they require
// either a multi-file cue (workspace/, src/, .ts) OR 15+ words OR 50+
// words total. So "add" with 8 words and no file path stays inline; "Add
// a feature to workspace/apps/X" delegates.
const LONG_TASK_VERB_RE = /\b(refactor|audit|investigate|implement|build|debug|trace|analyze|migrate|rewrite|add|create|make|extend|enhance|fix\s+(all|the|every|every\s+\w+|multiple)|set\s+up|wire\s+up|bootstrap|design\s+(and|then)|review\s+the)\b/i;

const MULTI_FILE_CUE_RE = /(workspace\/|src\/|node_modules|\.ts\b|\.tsx\b|\.js\b|\.py\b|across|throughout|every\s+file|multiple\s+files|all\s+the\s+(files|tests|components))/i;

const SHORT_TASK_RE = /^(yes|no|ok|sure|thanks|hi|hello|what|when|where|why|how|who)\b|^.{0,30}$/i;

// Constructive build phrase: build verb directly attached to an "app-shaped"
// noun. Matches "create an app", "build me a notes dashboard". Does NOT
// match passive mentions like "the app crashed" or "what's the best
// dashboard tool?" — verb must be the head of the phrase.
const BUILD_NOUN_RE = /\b(build|create|make|design|develop|set\s+up|wire\s+up|bootstrap|scaffold|spin\s+up|put\s+together)\s+(?:me\s+|us\s+|you\s+)?(?:a|an|the|some|another|new)\s+(?:new\s+|small\s+|simple\s+|basic\s+|quick\s+|tiny\s+|full\s+|proper\s+|\w+\s+)?(app|application|page|dashboard|tool|feature|component|panel|view|widget|integration|service|endpoint|api|website|site|extension|plugin|script|module|workflow|bot|interface|frontend|backend|ui)s?\b/i;

// Codex-specific: short investigative phrasings ("look into X", "why is Y
// happening") spiral on Codex from context bloat. Anthropic doesn't have
// the same failure profile so we don't lower its bar.
const CODEX_INVESTIGATIVE_RE = /\b(why\s+(is|are|does|did|won't|can'?t)|what\s+is\s+(causing|wrong|happening)|look\s+into|check\s+(why|if|whether)|find\s+out\s+(why|how)|figure\s+out\s+(why|how)|investigate|diagnose|trace|debug)\b/i;

// Discussion / workshop / synthesis cues. User is brainstorming or
// reacting, not asking for fresh research. Keep inline — worker would
// start fresh and lose all that conversation context.
const DISCUSSION_CUE_RE = /\b(what(?:'?s| do you| would you)\s+(?:think|the take|the play|the move|your take)|how (?:do|should|would|could) (?:we|i|you|that|they)|best of both worlds|how (?:does|do) (?:that|this) (?:sound|land|work|compare)|kind of like|sort of like|reminds me|on the other hand|vs\.?\s+|versus\s+|tradeoff|trade-off|pros and cons|opinion|honest take|gut check|what about|or should|or do we|or is it|why not|wouldn'?t it|isn'?t (?:it|that)|right\??$|agree\??$|thoughts\??$|make sense|am i (?:wrong|right|missing|crazy)|just kidding|half joking|brainstorm|workshop|riff|rant|hypothetical|musing|thinking out loud)\b/i;

// Slash-prefix escape hatch: "/discuss what about X" stays inline regardless.
const DISCUSS_PREFIX_RE = /^\s*\/(?:discuss|chat|talk|inline)\s+/i;

// User explicitly told the agent NOT to spawn a subagent in plain language.
// "dont spawn", "handle yourself", "you do it", "no subagent", etc.
const NO_SPAWN_OVERRIDE_RE = /\b(?:don'?t|do\s*not|no)\s+(?:spawn|delegate|subagent|sub[-\s]?agent|background\s+(?:it|this|task))\b|\b(?:handle|do)\s+(?:it|this|that)\s+(?:your\s*self|yourself)\b|\b(?:you|main\s*agent)\s+do\s+(?:it|this)\s+(?:your\s*self|yourself)?\b|\bnot?\s+(?:a\s+)?subagent\b/i;

// ── Public surface ─────────────────────────────────────────────────────

export function hasDiscussPrefix(message: string): boolean {
  return DISCUSS_PREFIX_RE.test(message);
}

export function stripDiscussPrefix(message: string): string {
  return message.replace(DISCUSS_PREFIX_RE, "");
}

/**
 * Apply the regex rule cascade. Returns the first matching rule's decision.
 * The LLM classifier may veto a DELEGATE result; INLINE results are trusted
 * (cheap path, no LLM call needed).
 */
export function decideByRegex(provider: string, message: string, channel: string): RouteDecision {
  if (channel !== "web") return { destination: "inline", reason: "non-web-channel", wordCount: 0 };
  const trimmed = message.trim();
  const wordCount = message.split(/\s+/).length;

  if (DISCUSS_PREFIX_RE.test(message)) {
    return { destination: "inline", reason: "discuss-prefix", wordCount };
  }
  if (NO_SPAWN_OVERRIDE_RE.test(message)) {
    return { destination: "inline", reason: "user-override-no-spawn", wordCount };
  }
  if (DISCUSSION_CUE_RE.test(message)) {
    return { destination: "inline", reason: "discussion-cue", wordCount };
  }
  // Codex-only investigative widening — runs BEFORE short-task filter
  // because that filter strips anything starting with why/what/how (the
  // exact words investigative prompts use). Tight length+word floor here
  // so a bare "why?" still stays inline.
  if (
    provider === "codex" &&
    trimmed.length > 30 &&
    wordCount > 4 &&
    CODEX_INVESTIGATIVE_RE.test(message)
  ) {
    return { destination: "delegate", reason: "codex-investigative", wordCount };
  }
  if (SHORT_TASK_RE.test(trimmed)) return { destination: "inline", reason: "short-task", wordCount };
  if (wordCount >= 50) return { destination: "delegate", reason: "word-count-50plus", wordCount };
  if (BUILD_NOUN_RE.test(message)) return { destination: "delegate", reason: "build-noun-phrase", wordCount };
  if (LONG_TASK_VERB_RE.test(message) && (wordCount >= 15 || MULTI_FILE_CUE_RE.test(message))) {
    return { destination: "delegate", reason: "long-task-verb+context", wordCount };
  }
  return { destination: "inline", reason: "no-rule-matched", wordCount };
}
