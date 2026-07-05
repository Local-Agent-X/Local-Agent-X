/**
 * Tool-search recovery guard — the model ends a turn DECLINING a capability
 * ("I don't have a tool for that", "I can't move the mouse") while making zero
 * tool calls. Most tools are deferred (loaded via tool_search to keep the eager
 * tier lean); a model that doesn't search just denies. Anthropic models search
 * on their own — Grok and other weaker tool-users don't, so the prompt-only
 * provider-rider (prepare-request/provider-riders.ts) isn't enough. This is the
 * enforcement: force ONE tool_search pass before the denial reaches the user.
 *
 * Unlike premature-completion (worker-only), this runs on ALL lanes incl.
 * interactive chat — the user-facing "I can't" is exactly the case to catch.
 * Safety comes from the phrase match, not the lane:
 *   - zero tool calls this turn  → a legit tool-block ran a tool, so it's excluded
 *   - capability-denial phrasing → excludes normal answers AND ethical refusals
 *   - already searched this op   → respect a real "searched, found nothing"
 *   - fire-once per op           → no loops
 */
import { type CanonicalMiddleware } from "./types.js";
import { getMiddlewareState } from "./state.js";
import { opForbidsCapability } from "../instruction-ledger/index.js";
import type { CapabilityClass } from "../../tool-registry.js";

interface FiredFlag { fired: boolean }

// Declining a CAPABILITY (no tool / can't do the action) — matched against the
// tail of the reply (its conclusion), case-insensitively.
const CAPABILITY_DENIAL: RegExp[] = [
  // "I don't have a/the … tool | ability | access | control | …"
  /\bi\s+(?:don'?t|do\s+not)\s+have\s+(?:a|an|the|any)?\s*[\w\s-]{0,40}?\b(?:tool|abilit|capabilit|access|function|feature|integration|means|way\s+to|permission|control|movement|automation)\b/i,
  // "I can't | cannot | could not | am not able to | am unable to … <action verb>"
  // ("I'm" is normalized to "I am" before matching, see looksLikeCapabilityDenial)
  /\bi\s+(?:can'?t|cannot|could\s+not|couldn'?t|am\s+(?:not\s+able|unable)\s+to)\s+[\w\s-]{0,24}?\b(?:move|click|type|press|control|drive|access|open|launch|run|do\s+(?:that|this|it)|interact|see|read|write|send|search|browse|fetch|generate|create|delete|install|automate)\b/i,
  // "no … tool | capability | ability | integration | automation | function"
  // (catches terse "No tool for mouse control", "no mouse-control capability")
  /\bno\s+[\w\s-]{0,24}?\b(?:tool|capabilit|abilit|integration|automation|function)\b/i,
  // "beyond | outside | not within my capabilities | abilities"
  /\b(?:beyond|outside|not\s+within)\s+my\s+(?:capabilit|abilit)/i,
];

// Ethical / willingness refusals — NOT capability gaps. Never force a tool
// search on these (hunting for a tool to do what we declined is nonsense).
const ETHICAL_REFUSAL =
  /\b(?:i\s+won'?t|i\s+will\s+not|not\s+comfortable|not\s+willing|against\s+my|can'?t\s+help\s+with\s+(?:that|this)\s+request|won'?t\s+(?:help|assist))\b/i;

// Terse-denial fallback: a SHORT tool-less reply that negates an action or
// capability. Catches laconic forms ("No mouse control.", "Can't click that.")
// the explicit patterns miss, without firing on long informative answers.
const NEGATION = /\b(?:no|not|cannot|can'?t|don'?t|doesn'?t|unable|lack)\b/i;
const CAPABILITY_CUE = /\b(?:tool|capabilit|abilit|click|type|control|automat|access|move|drive|launch|interact)\b/i;

/** True when `text` reads as the model declining a CAPABILITY (vs a normal
 *  answer or an ethical refusal). Pure + exported for direct testing. */
export function looksLikeCapabilityDenial(text: string): boolean {
  // Normalize so the patterns only handle spaced forms: curly → straight
  // apostrophe, then the "I'm" contraction → "I am".
  const norm = text.trim().replace(/’/g, "'").replace(/\bi'm\b/gi, "I am");
  if (!norm) return false;
  if (ETHICAL_REFUSAL.test(norm)) return false;
  if (CAPABILITY_DENIAL.some((re) => re.test(norm.slice(-600)))) return true;
  // Short + negation + capability cue → a terse denial.
  return norm.length <= 160 && NEGATION.test(norm) && CAPABILITY_CUE.test(norm);
}

// What capability a denial is ABOUT — matched against the reply text. Only
// consulted for classes the op's instruction ledger actually forbids, so with
// no user constraint (the common case) none of these are ever tested.
const CAPABILITY_TOPIC_CUES: Record<CapabilityClass, RegExp> = {
  "egress": /\b(?:brows\w*|web|internet|online|network|url|http|website|site|fetch\w*|download\w*)\b/i,
  "workspace-write": /\b(?:writ\w*|edit\w*|modif\w*|creat\w*|delet\w*|sav\w*)\b/i,
  "shell": /\b(?:shell|terminal|bash|command|script|execut\w*)\b/i,
  "sensitive-read": /\b(?:credential|secret|password|keychain|token|api\s*key)\b/i,
};

/** True when the denial reads as the model HONORING a user prohibition (the
 *  declined capability is one the ledger forbids) — not as a missed tool. */
function denialHonorsProhibition(opId: string, text: string): boolean {
  return (Object.keys(CAPABILITY_TOPIC_CUES) as CapabilityClass[]).some(
    (cls) => opForbidsCapability(opId, cls) && CAPABILITY_TOPIC_CUES[cls].test(text),
  );
}

export const toolSearchNudgeMiddleware: CanonicalMiddleware = {
  name: "tool-search-nudge",

  afterModelCall(ctx) {
    if (ctx.toolCalls.length > 0) return { kind: "continue" };          // it tried a tool
    if (ctx.toolsCalledThisOp.has("tool_search")) return { kind: "continue" }; // already searched
    if (!looksLikeCapabilityDenial(ctx.assistantContent)) return { kind: "continue" };
    // TARGETED suppression: "I can't browse" after the user forbade egress is
    // compliance, not a capability gap — don't push it to search for a tool the
    // user banned. Denials about NON-forbidden capabilities still nudge.
    if (denialHonorsProhibition(ctx.op.id, ctx.assistantContent)) return { kind: "continue" };

    const flag = getMiddlewareState<FiredFlag>(
      ctx.op.id,
      "tool-search-nudge",
      () => ({ fired: false }),
    );
    if (flag.fired) return { kind: "continue" };
    flag.fired = true;

    const message =
      "Stop — before telling the user that isn't possible: your tool list is NOT " +
      "exhaustive. Most tools load on demand and aren't shown up front. Call " +
      "`tool_search` describing what you're trying to do (e.g. \"control the mouse " +
      "and keyboard\", \"move the cursor and click\") and use whatever it returns. " +
      "Only say you can't AFTER a search comes back with nothing relevant.";

    return { kind: "nudge", message, reason: "tool-search-recovery" };
  },
};
