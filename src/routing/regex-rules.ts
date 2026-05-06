/**
 * Routing regex shortcuts. Four obvious INLINE cases short-circuit the
 * decision; everything else falls through to the LLM classifier (the
 * primary decider for ambiguous messages).
 *
 * Shortcuts (all → INLINE, definitive=true):
 *   1. discuss-prefix       — "/discuss what about X"
 *   2. user-override        — "don't spawn", "handle this yourself", etc.
 *   3. ack-greeting         — bare "yes", "ok", "thanks", "hi"
 *   4. ui-toggle            — "dark mode", "switch to light", etc. The
 *                             chat agent handles theme/sidebar/voice
 *                             toggles via a single inline tool call;
 *                             these are NOT worker delegations. The LLM
 *                             classifier was labeling them DELEGATE
 *                             because "needs tools" — wrong signal.
 *
 * No DELEGATE shortcuts. The LLM classifier is the only path to DELEGATE.
 * Its rule: if fulfilling the request requires worker-class tools (file
 * writes, builds, multi-step research, browsing), DELEGATE; if it's
 * answerable from training/conversation OR is a single quick UI tool
 * call, INLINE.
 *
 * Why no DELEGATE shortcuts? The previous heuristics (word-count buckets,
 * verb-phrase regex) created a regression: "create a kanban board app" (25
 * chars) hit a `^.{0,30}$` short-task rule and was forced INLINE before the
 * build-noun rule could see it. Both inline providers then timed out on
 * the build. Tool-need is the right signal, and only the LLM can predict it.
 */

import type { RouteDecision } from "./types.js";

const DISCUSS_PREFIX_RE = /^\s*\/(?:discuss|chat|talk|inline)\s+/i;

const NO_SPAWN_OVERRIDE_RE = /\b(?:don'?t|do\s*not|no)\s+(?:spawn|delegate|subagent|sub[-\s]?agent|background\s+(?:it|this|task))\b|\b(?:handle|do)\s+(?:it|this|that)\s+(?:your\s*self|yourself)\b|\b(?:you|main\s*agent)\s+do\s+(?:it|this)\s+(?:your\s*self|yourself)?\b|\bnot?\s+(?:a\s+)?subagent\b/i;

// Pure conversational acks/greetings — short and obviously chat. Tight
// regex; anything fancier goes to the LLM.
const ACK_GREETING_RE = /^\s*(yes|no|ok|okay|sure|thanks|thank\s+you|ty|yep|yeah|nope|hi|hey|hello|cool|nice|got\s+it|👍|🙏)[\s.!?]*$/i;

// UI-toggle commands the chat agent handles via a single inline tool call
// (theme, sidebar pins, voice on/off, etc). The LLM classifier was
// labeling these DELEGATE because "needs tools" — but inline tool calls
// are NOT worker delegations. Spawning a worker for "switch to dark
// mode" is absurd; the worker has no UI context and can't even reach
// the settings the chat agent flips inline. Short-circuit them here.
//
// Conservative — only matches whole-phrase commands that are clearly
// about flipping app state. Anything ambiguous still falls through to
// the LLM.
const UI_TOGGLE_RE = /^\s*(?:please\s+)?(?:can\s+you\s+|could\s+you\s+|would\s+you\s+)?(?:turn|switch|set|change|flip|enable|disable|use|go|put)\s+(?:on\s+|off\s+|to\s+)?(?:the\s+app\s+|app\s+|the\s+)?(?:dark|light|system)\s*(?:mode|theme)?[\s.!?]*$/i;
const UI_TOGGLE_RE_2 = /^\s*(?:dark|light|system)\s*(?:mode|theme)\s*(?:please)?[\s.!?]*$/i;

export function hasDiscussPrefix(message: string): boolean {
  return DISCUSS_PREFIX_RE.test(message);
}

export function stripDiscussPrefix(message: string): string {
  return message.replace(DISCUSS_PREFIX_RE, "");
}

/**
 * Apply regex shortcuts. Returns a `definitive` INLINE decision when one of
 * the three obvious cases matches, otherwise returns a non-definitive
 * placeholder so the router falls through to the LLM classifier.
 */
export function decideByRegex(_provider: string, message: string, channel: string): RouteDecision {
  const wordCount = message.split(/\s+/).filter(Boolean).length;

  if (channel !== "web") {
    return { destination: "inline", reason: "non-web-channel", wordCount, definitive: true };
  }
  if (DISCUSS_PREFIX_RE.test(message)) {
    return { destination: "inline", reason: "discuss-prefix", wordCount, definitive: true };
  }
  if (NO_SPAWN_OVERRIDE_RE.test(message)) {
    return { destination: "inline", reason: "user-override-no-spawn", wordCount, definitive: true };
  }
  if (ACK_GREETING_RE.test(message)) {
    return { destination: "inline", reason: "ack-greeting", wordCount, definitive: true };
  }
  if (UI_TOGGLE_RE.test(message) || UI_TOGGLE_RE_2.test(message)) {
    return { destination: "inline", reason: "ui-toggle", wordCount, definitive: true };
  }
  return { destination: "inline", reason: "no-shortcut", wordCount, definitive: false };
}
