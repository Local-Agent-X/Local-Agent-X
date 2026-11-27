/**
 * A reply that ends the turn naming a next step the agent itself would take:
 * "The next step is to pinpoint why the on-device request failed." A GPT chat
 * testing an app on the owner's phone ended two turns that way, and the owner
 * typed "?" to get it going (Label Check Sol, 2026-11-27). The closing tool's
 * own refusal (tools/wrap-up.ts) does not see a reply that ends in prose, and
 * the one-line announcement check (empty-turn-termination.ts) does not see a
 * full answer with the promise in the middle.
 *
 * The reply is already on the user's screen; re-driving it once only asks the
 * agent to take the step or say what stops it. So the test is for a promise of
 * ACTION ("I'll check", "the next step is to pinpoint"), not of intent ("I'll
 * leave the folder untouched", "I wouldn't retry"), and never when the reply
 * asks the user something.
 */

import { findTextToolCallRanges } from "../adapters/tool-call-text-syntaxes.js";

const ACTION_VERBS =
  "check|run|rerun|look|pinpoint|fix|test|retest|try|retry|investigate|dig|find|debug|inspect|verify|search|read|open|" +
  "trace|capture|pull|grab|reproduce|compare|confirm|install|launch|build|rebuild|scan|diagnose|narrow|figure|work";

/** "the next step is to <verb>", "I'll <verb>", "next I'll <verb>", "let me <verb>", with up to two words between. */
const ACTION_PROMISE = new RegExp(
  String.raw`\b(?:(?:the\s+)?next\s+step\s+(?:is|would\s+be|will\s+be)\s+to|I['’]ll|I\s+will|I['’]m\s+going\s+to|next,?\s+I['’]ll|let\s+me)` +
    String.raw`\s+(?:\w+\s+){0,2}?(?:${ACTION_VERBS})\b`,
  "i",
);

/** A sentence of the reply that ends in a question mark: the user is being asked. */
function asksTheUser(text: string): boolean {
  return /\?\s*(?:$|\n|["'”*_)\]]*\s)/.test(text);
}

/** The words of the promise, for the nudge; null when the reply promises no action of the agent's own. A reply
 *  that holds tool-call text ("Let me search. <function_calls>...") is the tool-intent gate's
 *  (tool-intent-gate.ts): two nudges on one turn would contradict each other. */
export function namedNextStep(reply: string): string | null {
  const text = reply.trim();
  if (!text || asksTheUser(text)) return null;
  if (findTextToolCallRanges(text, undefined, { maskCodeSpans: true }).length > 0) return null;
  const hit = ACTION_PROMISE.exec(text);
  if (!hit) return null;
  const sentence = text.slice(hit.index).split(/(?<=[.!])\s/)[0] ?? hit[0];
  return sentence.replace(/\s+/g, " ").slice(0, 160);
}

export function namedNextStepNudge(step: string): string {
  return `Your reply ended the turn on a step you would take yourself ("${step}"). Take it now, with tool calls. ` +
    "If something stops you (it needs the user, a device, a decision, or it is out of scope), say what in one line instead.";
}
