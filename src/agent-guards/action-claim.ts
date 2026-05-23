// Tool-verified hallucination check.
//
// The iteration===0 gate on checkCreationHallucination misses hallucinations
// that happen on iteration N where the agent made SOME tool call on iter 0
// but then claimed a different, un-executed action at the end. This check
// closes that gap by requiring that any claimed action verb maps to a tool
// that was actually called this turn.

import { stripCodeBlocks } from "./code-strip.js";

/**
 * Verb classes → tool names that perform that verb. If the assistant claims
 * an action in one of these classes and NONE of the listed tools was called
 * this turn, that's a hallucinated action.
 *
 * Add entries when new action-style tools land. Missing a mapping produces a
 * false positive (nudge when work was legit) — that's annoying but not
 * dangerous. Missing an entry in the verb regex produces a false NEGATIVE
 * (real hallucination slips through) — that's the worse failure mode, so
 * keep the verb regex tight and the tool list generous.
 */
const ACTION_VERB_TO_TOOLS: Array<{ verb: RegExp; tools: string[] }> = [
  // "removed/unpinned/deleted X" — lots of tools can remove state
  { verb: /\b(removed?|unpinned?|deleted?|dropped?|cleared?|unscheduled?)\b/i, tools: [
    "sidebar_unpin", "secret_delete", "cron_delete", "bash", "memory_delete",
    "http_request", "delete", "browser", "agent_cancel", "mission_cancel",
    "skill_remove", "cron_toggle", "email_draft",
  ] },
  // "added/pinned/scheduled/created X"
  { verb: /\b(added?|pinned?|scheduled|created|wrote|built|saved|installed)\b/i, tools: [
    "sidebar_pin", "secret_save", "browser_capture_to_secret", "cron_create",
    "mission_schedule_create", "memory_save", "memory_update_profile", "write",
    "build_app", "skill_install", "http_request", "agent_spawn", "delegate",
    "email_setup", "operation_start", "bash", "edit",
  ] },
  // "noted/remembered/recorded/logged X" — memory-specific claim verbs.
  // Real-world failure: model says "noted, I'll remember that" or "got it,
  // saved" without calling memory_save/memory_update_profile. This guard
  // forces a retry — the model has to either actually call the tool or
  // rephrase its reply to not claim the action. Same pattern as the other
  // verb classes; just specifically scoped to memory tools so other
  // claims ("noted in the bash log") don't false-positive into needing
  // memory_save. Includes both present-tense ("remember", "bookmark") and
  // past-tense ("remembered", "bookmarked") because future-tense claims
  // ("I'll remember that") are hollow promises that need the same retry.
  { verb: /\b(notes?|noted|remembers?|remembered|records?|recorded|logs?|logged|bookmarks?|bookmarked|memorizes?|memorized|stores?|stored)\b/i, tools: [
    "memory_save", "memory_update_profile",
  ] },
  // "sent/posted/emailed/messaged"
  { verb: /\b(sent|posted|emailed|messaged|tweeted|published|mailed)\b/i, tools: [
    "email_send", "email_draft", "whatsapp_send", "telegram_send", "http_request",
    "browser",
  ] },
  // "updated/edited/modified/changed/renamed" — sidebar_pin/unpin deliberately
  // excluded here. "Update X" on app content is about writing/editing files,
  // not pinning to the sidebar. Including sidebar tools in this verb class
  // created false-positive hallucination pressure that biased toward pins.
  { verb: /\b(updated?|edited?|modified|changed|renamed|patched|configured)\b/i, tools: [
    "edit", "write", "http_request", "secret_save", "memory_update_profile",
    "cron_update", "mission_schedule_update", "email_setup", "browser", "bash",
  ] },
];

const CLAIM_AT_REPLY_START_RE = /(?:^|\n)\s*[-*]?\s*(Removed|Unpinned|Deleted|Dropped|Cleared|Unscheduled|Added|Pinned|Scheduled|Created|Wrote|Built|Saved|Installed|Sent|Posted|Emailed|Messaged|Published|Mailed|Updated|Edited|Modified|Changed|Renamed|Patched|Configured|Noted|Remembered|Recorded|Logged|Bookmarked|Memorized|Stored)\b/i;
// First-person claim — past tense for completed actions ("I saved X") plus
// present/future-tense forms for memory verbs ("I'll remember", "I'll note",
// "I will bookmark"). The future tense is treated as a claim too because
// "I'll remember that" without a memory tool call is a hollow promise — the
// model commits to durable storage that won't actually happen unless we
// force the retry. Non-memory verbs stay past-tense-only (claiming "I'll
// send the email" is normal in-task language and shouldn't trigger a retry).
const CLAIM_FIRST_PERSON_RE = /\bI(?:'ve|'ll| have| will)?\s+(removed|unpinned|deleted|dropped|cleared|unscheduled|added|pinned|scheduled|created|wrote|built|saved|installed|sent|posted|emailed|messaged|published|mailed|updated|edited|modified|changed|renamed|patched|configured|noted?|remembers?|remembered|records?|recorded|logs?|logged|bookmarks?|bookmarked|memorizes?|memorized|stores?|stored)\b/i;

/**
 * Return a nudge if the assistant's reply claims an action verb whose
 * matching tools were NOT called this turn. Pass the list of tool NAMES
 * invoked anywhere in the current turn (across all iterations).
 */
export function checkUnmatchedActionClaim(
  text: string,
  toolsCalledThisTurn: Set<string>,
): string | null {
  if (!text) return null;
  const cleaned = stripCodeBlocks(text);
  if (!cleaned) return null;
  if (!CLAIM_AT_REPLY_START_RE.test(cleaned) && !CLAIM_FIRST_PERSON_RE.test(cleaned)) return null;
  text = cleaned; // downstream verb-class regex tests use the cleaned form too

  // Find which verb classes the reply claims
  const claimedVerbs: string[] = [];
  const missingTools: string[][] = [];
  for (const entry of ACTION_VERB_TO_TOOLS) {
    if (!entry.verb.test(text)) continue;
    const matched = entry.tools.some(t => toolsCalledThisTurn.has(t));
    if (!matched) {
      claimedVerbs.push(entry.verb.source.replace(/[()\\b?]/g, "").split("|")[0]);
      missingTools.push(entry.tools);
    }
  }
  if (claimedVerbs.length === 0) return null;

  const expected = Array.from(new Set(missingTools.flat())).slice(0, 6).join(", ");
  return (
    `You claimed an action (${claimedVerbs.join(", ")}) but no matching tool was called this turn. ` +
    `Tools actually called: ${Array.from(toolsCalledThisTurn).join(", ") || "(none)"}. ` +
    `Call one of the matching tools now (${expected}), or correct your reply if the action was actually not done.`
  );
}
