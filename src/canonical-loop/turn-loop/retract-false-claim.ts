// When a hallucination guard fires on a terminal turn, the model's just-
// streamed text is a confirmed-false claim of work that never happened
// ("Worker already on it, build running in the background", "I scheduled the
// job"). The guard nudges the model to redo the turn, but without this the
// false bubble stays — the user is left with a lie sitting next to the
// correction the next turn produces. Live failure 2026-06-02: "I want to
// start a company" drew a phantom "Worker already on it" claim; the user
// read it as real background work, abandoned the chat, and re-sent in a new
// one — producing a duplicate build.
//
// Retraction removes the false assistant text from the committed transcript
// here; the caller also clears the live stream bubble with a replace:true
// chunk. The next turn's answer becomes the only assistant message the user
// sees, in both the live view and on reload.
//
// The set covers two shapes the next turn SUPERSEDES, so the premature text
// shouldn't stand: (1) confirmed-false work claims — worker-hallucination
// (provably false from the tool-call ledger — no spawn-class call fired),
// creation-hallucination (LLM-verified before it nudges); and (2) premature
// "I can't" denials the model is being nudged to recover from —
// tool-search-recovery (claimed a missing tool), browser-handoff (gave up on a
// surmountable obstruction). approval-hallucination is excluded: "requires
// approval" is a misplaced permission ask, not superseded work, so it stands.

import type { CommitTurnMessage } from "../checkpoint.js";

const RETRACTABLE_REASONS: ReadonlySet<string> = new Set([
  "worker-hallucination",
  "creation-hallucination",
  // The model claimed it lacks a tool/capability ("I have no tool for mouse
  // control") and the tool-search-nudge guard is forcing it to tool_search
  // first. Retract the premature denial so the user sees only the post-search
  // answer — whether that's the completed action or a genuine "still can't"
  // (the user shouldn't watch it say "I can't" and then immediately do it).
  "tool-search-recovery",
  // A give-up / hand-off punt the browser-handoff gate is nudging the model to
  // recover from ("I'm blocked by the overlay — you dismiss it / give me a
  // token"). Same shape as tool-search-recovery: a premature "I can't" the
  // nudge supersedes. Retract it so the user sees only the post-nudge result.
  // If the model re-punts, that terminal turn carries a `continue` (the gate
  // nudges once), so it is NOT retracted — the single honest punt stands, and
  // decide-outcome records it `partial`.
  "browser-handoff",
  // The final summary credited the result with a tool/model/service it never
  // used (attribution-claim gate, model-graded). Retract the confabulated text
  // so only the nudged, accurate re-narration stands. Unlike the others this
  // fires on a turn that DID call a tool — stripRetractedAssistant drops only
  // the assistant text, so the real tool result (e.g. the created deck) is kept.
  "attribution-confabulation",
]);

export function isRetractableHallucination(reason: string | null | undefined): boolean {
  return reason != null && RETRACTABLE_REASONS.has(reason);
}

// Drop assistant messages (the false claim) while preserving any tool
// messages. The hallucination guards only fire on tool-less terminal turns,
// so in practice this empties the turn — but filtering by role keeps it
// correct if that invariant ever changes.
export function stripRetractedAssistant(messages: CommitTurnMessage[]): CommitTurnMessage[] {
  return messages.filter(m => m.role !== "assistant");
}
