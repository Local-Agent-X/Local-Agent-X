/**
 * LLM identity-fact extractor — replaces the hand-rolled regex in
 * `src/memory/auto-extract.ts` that has been silently trying to rename the
 * agent to "Done" / "Cool" / "Hello" / "Welcome" any time a message starts
 * with a capitalized short word and ends with a period.
 *
 * The pre-existing STOP_WORDS list catches common acks but is incomplete and
 * grows by accident every time the user uses a new short word. Worse: the
 * regex misses real renames that don't fit its narrow shapes (e.g. "let's
 * call you Ari" — none of the rename patterns match).
 *
 * This classifier is the structural fix:
 *   - Returns null if no identity fact is present (the common case).
 *   - Returns the structured field(s) the user actually stated, leaving
 *     unstated fields null.
 *   - Crucially: doesn't infer. "I'm tired" doesn't extract "tired" as a
 *     user name. "Done." doesn't extract "Done" as the agent name.
 *
 * Caller (`auto-extract.ts`) writes whatever the classifier returns to
 * IDENTITY.md / USER.md and skips the regex path entirely. Safe to fail
 * silently — if the classifier returns null, no write happens (vs the
 * previous behavior where a regex misfire would corrupt durable memory).
 */

import { classifyJson } from "./classify-with-llm.js";

const SYSTEM_PROMPT = `You extract durable identity facts AND durable preference / biographical statements from a user's message to a chat agent. ONLY extract facts the user EXPLICITLY stated. Do not infer, do not guess.

Output JSON with these fields (omit or set to null when not stated):
{
  "user_name": <string | null>,        // user told us their own name (e.g. "I'm Alex", "call me Mike", "my name is Ana")
  "agent_name": <string | null>,       // user told the agent its new name ("call yourself X", "your name is Y", "I'll call you Z")
  "user_location": <string | null>,    // explicit "I live in X" / "I moved to Y" — proper-noun place
  "user_employer": <string | null>,    // explicit "I work at X" — actual employer name
  "user_role": <string | null>,        // explicit profession ("I'm a developer", "I'm a nurse")
  "family_count": <{relation: string, n: number} | null>,  // "I have 2 kids" / "I have 3 daughters"
  "preference_rule": <string | null>,     // durable instruction about how to respond / behave: "never greet me in Spanish", "always use light mode", "I prefer concise answers", "stop using emojis"
  "biographical_event": <string | null>   // durable life event: "my dog gigi passed away last Thursday", "I got married yesterday", "we just moved to Austin", "my mom is in the hospital"
}

Critical rejections (return all-null):
- Short ack messages: "Done.", "Cool.", "Hello.", "Welcome.", "Nice." — these are reactions, NOT facts.
- Fragmentary states: "I'm tired", "I'm here", "I'm back", "I'm good" — these are states, NOT names or roles.
- Hypothetical or third-person: "if my name was X", "she's called Y" — not the user.
- Quotes / instruction / examples — not the user's own statement.
- One-shot task requests: "make the button green this time", "use a sans serif font here" — scoped to a single task, NOT a durable rule. preference_rule is for behavior that should persist across sessions.

Rewriting for preference_rule and biographical_event:
- Phrase as a third-person statement about the user, transferable across sessions. Bad: "stop using emojis". Good: "User prefers responses without emojis."
- Include any concrete entity names with @-prefix where natural ("@gigi", "@nutrishop").
- Keep to ONE sentence, ≤180 characters.

Reply with exactly the JSON object on a single line. No fences, no prose.`;

export interface IdentityFacts {
  user_name?: string | null;
  agent_name?: string | null;
  user_location?: string | null;
  user_employer?: string | null;
  user_role?: string | null;
  family_count?: { relation: string; n: number } | null;
  preference_rule?: string | null;
  biographical_event?: string | null;
}

export async function extractIdentityFactsWithLLM(
  userMessage: string,
  opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string },
): Promise<IdentityFacts | null> {
  if (!userMessage || userMessage.trim().length < 2) return null;
  // Cheap pre-skip: extremely long messages almost certainly aren't a single-
  // shot identity statement. The cap was 600 chars when this only handled
  // names/roles; biographical_event commonly arrives inside a longer story
  // ("we had a tough day, the vet called this morning and gigi passed away
  // last Thursday after a long fight…"), so the cap is bumped to 1200 to
  // let those through. Beyond 1200 it's almost certainly a multi-fact story
  // that belongs to the dream/consolidation path, not single-shot extract.
  if (userMessage.length > 1200) return null;

  return classifyJson<IdentityFacts>({
    category: "identity-extract",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: `User message:\n"${userMessage}"\n\nReply with the JSON object only.`,
    timeoutMs: opts?.timeoutMs ?? 4000,
    model: opts?.model,
    envDisableVar: "LAX_LLM_IDENTITY_EXTRACT",
    signal: opts?.signal,
    validate: (parsed) => {
      if (!parsed || typeof parsed !== "object") return null;
      const p = parsed as IdentityFacts;
      // Sanity caps — the classifier should already do this, but defense.
      if (p.user_name && (p.user_name.length < 2 || p.user_name.length > 40)) p.user_name = null;
      if (p.agent_name && (p.agent_name.length < 2 || p.agent_name.length > 40)) p.agent_name = null;
      if (p.user_location && p.user_location.length > 100) p.user_location = null;
      if (p.user_employer && p.user_employer.length > 80) p.user_employer = null;
      if (p.user_role && p.user_role.length > 60) p.user_role = null;
      if (p.preference_rule && (p.preference_rule.length < 8 || p.preference_rule.length > 200)) p.preference_rule = null;
      if (p.biographical_event && (p.biographical_event.length < 8 || p.biographical_event.length > 200)) p.biographical_event = null;
      const any =
        p.user_name || p.agent_name || p.user_location || p.user_employer ||
        p.user_role || p.family_count || p.preference_rule || p.biographical_event;
      return any ? p : { user_name: null }; // return empty-shape so caller knows it ran
    },
  });
}
