/**
 * The edit-directive veto — a message that tells the agent to edit is never a
 * whole-workspace write ban. Split from extract.ts (file-size gate); the
 * extractor calls it on both the LLM and the deterministic tier.
 */
import type { CapabilityClass } from "../../tool-registry.js";

// An explicit instruction to change code: an imperative edit verb opening a
// sentence or clause ("Fix the code in x.py", "…, and fix the parser"). A
// message that says this is, by its own words, not a no-edit session.
const EDIT_DIRECTIVE =
  /(?:^|[.!?\n]\s*|[,;]\s*(?:and\s+|then\s+)?|\b(?:please|now|then|and)\s+)(?:fix|edit|implement|update|modify|change|refactor|rename|add|remove|delete|write|rewrite|create|replace|correct|patch)\b(?!\s+(?:nothing|no\s+changes)\b)/im;

// Diagnose-only cues that stand on their own. Deliberately NOT the generic
// "don't change/edit X" negation: that is exactly the scoped carve-out ("don't
// change the tests") this veto exists to see through.
const DIAGNOSE_ONLY =
  /\bread[- ]?only\b|\b(?:don['’]?t|do\s+not)\s+do\s+anything\b|\b(?:just|only)\s+tell\s+me\s+(?:what|which|where|why|how|if|whether)\b|\b(?:don['’]?t|do\s+not)\s+(?:edit|modify|change|touch|write)\s+(?:any(?:thing)?|a\s+(?:single\s+)?(?:file|line)|files|code)\b(?!\s+else)/i;

/**
 * Drop a `workspace-write` ban when the SAME message tells the agent to edit.
 *
 * The LLM confirm is told this rule ("if the message asks you to edit …, do NOT
 * return workspace-write") but nothing enforced it, and a wrong verdict bricks
 * the task the message asked for. Aider's retry prompt — "The tests are
 * correct, don't try and change them. Fix the code in phone_number.py" — came
 * back as a whole-workspace write ban (2026-09-17): the model diagnosed the fix
 * and every write, edit and edit_lines call was refused. "Don't change the
 * tests, fix the code" is also simply how people ask for a fix.
 *
 * Applied to BOTH tiers. Unlike the partitive veto this needs no attribution:
 * "edit X" and "edit nothing" cannot both hold, so the ban survives only beside
 * an unambiguous diagnose-only cue ("read-only", "just tell me why", "don't
 * edit any files").
 */
export function vetoWriteBanOnEditDirective(prohibitions: readonly CapabilityClass[], userMessage: string): CapabilityClass[] {
  if (!prohibitions.includes("workspace-write")) return [...prohibitions];
  if (!EDIT_DIRECTIVE.test(userMessage) || DIAGNOSE_ONLY.test(userMessage)) return [...prohibitions];
  return prohibitions.filter((c) => c !== "workspace-write");
}

/** Exported for direct tests. */
export function directsAnEdit(userMessage: string): boolean {
  return EDIT_DIRECTIVE.test(userMessage) && !DIAGNOSE_ONLY.test(userMessage);
}
