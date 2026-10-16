/**
 * Which irreversible TOOLS the irreversible floor (approval-decision.ts) cards.
 *
 * What can be undone is each destructive tool's policy row (`undo`); an
 * irreversible tool asks before running unless its row says why not
 * (`uncarded`), so a tool added later is carded by default. Under Power (the
 * default profile) destructive means "allow", so until 2026-09-26 app_delete, a
 * confirmed memory_forget and marketplace_install ran with no card.
 */
import { policyRowOf } from "./tool-registry.js";

const USER_ASKED_TO_FORGET = /\b(forget|delete|erase|remove|wipe|scrub|purge)\b/i;

/** The human's own latest message asks for something to be forgotten. A
 *  forget they asked for is theirs to have, with no second question. */
export function userAskedToForget(userText: string): boolean {
  return USER_ASKED_TO_FORGET.test(userText);
}

/** Why a non-shell tool call cannot be undone and needs its confirm, or null.
 *  `userText` is the human's latest message: a hard forget they asked for in
 *  their own words is theirs to have, with no second question. */
export function irreversibleToolReason(
  toolName: string,
  args: Record<string, unknown>,
  userText = "",
): string | null {
  const undo = policyRowOf(toolName)?.undo;
  if (!undo || !("irreversible" in undo) || undo.uncarded) return null;
  // A two-step forget: the first call previews, only `confirm: true` deletes.
  if (undo.previewsUntil) {
    if (args[undo.previewsUntil] !== true) return null;
    if (userAskedToForget(userText)) return null;
  }
  return `irreversible tool (${toolName})`;
}
