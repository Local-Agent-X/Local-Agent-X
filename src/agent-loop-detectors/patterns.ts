// Regex patterns used across detectors, plus the waiting-on-user predicate.

export const PLANNING_FUTURE_PROMISE =
  /\b(?:i(?:'ll| will)|i(?:'m| am)\s+going\s+to|let\s+me|first[, ]+i(?:'ll| will)|next[, ]+i(?:'ll| will)|then[, ]+i(?:'ll| will))\b/i;

export const ACTION_VERB =
  /\b(?:inspect|investigate|check|look(?:\s+into|\s+at)?|read|search|find|debug|fix|patch|update|change|edit|write|implement|run|test|verify|review|analy(?:s|z)e|summari(?:s|z)e|explain|answer|show|share|report|save|add|create|build|send|post|publish|deploy|remove|delete)\b/i;

export const CONTINUATION_CUE =
  /\b(?:next|then|after(?:wards)?|once|subsequently|following\s+this)\b/i;

// Reply openers that signal "this is a recap of completed work, not a plan".
// When the first non-whitespace token is one of these, planning-only must not
// fire — incidental "I'll restart the server" follow-up notes inside a recap
// are not future promises that need re-engagement.
export const COMPLETION_OPENER =
  /^\s*(?:[*_`#>-]\s*)?(?:Done|Shipped|Fixed|Patched|All\s+(?:set|three|fixed|done|good)|Patch\s+(?:landed|applied|shipped|in)|Build\s+(?:passed|ok|complete|green)|Recap|Summary)\b/i;

// Past-tense completion phrases at sentence-start (string-start, after
// ./!/?, after newline, or after markdown bullet/list/heading prefix).
// Catches the case where the reply opens with a status line ("Build CLI
// timed out. I'll write it directly...") but ends with a completion recap
// ("Built **MyApp** at workspace/apps/myapp/...") — that "Built"
// follows a period+space, so it counts as sentence-start.
//
// Anchoring to sentence-start (not anywhere in text) avoids false-negatives
// where the phrase is buried mid-sentence ("...I think I should have built
// the file properly. I'll fix that next.") which is a real planning case.
// When a committing tool ran this turn AND a sentence-start completion
// phrase fires, the "I'll" later in the text is an incidental follow-up
// note in a recap — skip planning-only.
export const COMPLETION_PHRASE_AT_SENTENCE_START =
  /(?:^|[.!?]\s+|\n)\s*(?:[*_`#>-]\s*)?(?:Built|Created|Wrote|Made|Implemented|Shipped|Saved|Pinned|Installed|Deployed|Pushed|Committed|Patched|Landed|Finished|Completed)\s+(?:\*\*|`|the\s+|a\s+|an\s+|to\s+)?[A-Za-z]/;

// Signals that the agent is legitimately blocked waiting for user input.
// When any of these fire, all the "you didn't do enough" retry detectors must
// stand down — forcing the agent to keep working when it's blocked just
// respawns the same browser/tool churn with no new input to act on.
//
// This regex looks for three things the agent says in genuine-blocker replies:
//   1. Sentence-initial imperative asking the user to do something
//      ("Send me the invoice", "Drop the file", "Paste the link")
//   2. Explicit requests/conditions ("can you send", "when you're ready",
//      "let me know when", "tell me when")
//   3. Agent-flagged need for input ("I need the ...", "Before I can ...")
//
// It deliberately does NOT match first-person promises like "I'll send the
// email" — those should still trigger planning-only retries when appropriate.
//   4. Clarifying / choice questions the agent poses back to the user
//      ("What do you want first?", "Which of these would you like?",
//      "Want me to build the site or the curriculum?"). When the agent
//      ends a turn asking the user to choose a direction, forcing "commit
//      work now" overrides a legitimate question — exactly the misfire
//      that built two unwanted websites from "I want to start a company"
//      (it asked "what do you want first?" and got nudged into build_app).
const WAITING_ON_USER =
  /(?:^|[.!?—–:;]\s*|\n)\s*(?:please\s+|kindly\s+)?(?:send|share|paste|drop|upload|attach|provide|post|give|show)\s+(?:me|the|it|us|your|a)\b|(?:can|could|would)\s+you\s+(?:send|share|paste|drop|upload|attach|provide|post|give|show|tell|let)\b|when\s+you(?:'re| are)?\s+(?:ready|done|have|get|finish)|let\s+me\s+know\s+(?:when|once|if|what|which|your|how)|tell\s+me\s+(?:when|once|if|what|who|where|how|the|your)|\bi\s+need\s+(?:the|your|more|you\s+to)\b|\bbefore\s+i\s+(?:can|proceed|continue|start)\b|\bonce\s+you\s+(?:send|share|provide|tell|have|do|'ve|are)\b|\bdrop\s+(?:it|them|that|the)\b|\bwhat\s+(?:do|would)\s+you\s+(?:want|like|prefer|need)\b|\bwhich\s+(?:one|option|of\s+(?:these|those|them)|would|do)\b|\bwould\s+you\s+like\s+me\s+to\b|\b(?:do\s+you\s+)?want\s+me\s+to\b|\bshould\s+i\b/i;

/**
 * True if the agent's reply clearly signals it is blocked waiting on the user.
 * When true, the post-turn detectors must NOT fire — "keep going" is wrong
 * when there's nothing to keep going on.
 */
export function isWaitingOnUser(text: string): boolean {
  if (!text) return false;
  return WAITING_ON_USER.test(text);
}

export const RETRY_SAFE_EXPLORATORY_TOOLS = new Set([
  "read",
  "bash",
  "list_files",
  "ls",
  "search",
  "find",
  "grep",
  "glob",
  "web_fetch",
  "web_search",
]);
