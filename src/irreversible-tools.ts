/**
 * Which irreversible TOOLS the irreversible floor (approval-decision.ts) cards.
 *
 * The table of what can be undone lives in tools/undo-pairs.ts; this file only
 * decides which of its IRREVERSIBLE tools ask before running. Under Power (the
 * default profile) destructive means "allow", so until 2026-09-26 app_delete, a
 * confirmed memory_forget and marketplace_install ran with no card.
 */
import { IRREVERSIBLE } from "./tools/undo-pairs.js";

/**
 * Irreversible tools the floor does NOT card, each with why. Every other
 * irreversible tool gets one confirm in an interactive run, so a tool added to
 * that table later is carded by default.
 */
export const IRREVERSIBLE_TOOLS_UNCARDED: Readonly<Record<string, string>> = {
  op_kill: "stops a run; nothing the user owns is destroyed, and the stop is usually the user's own",
  agent_cancel: "stops a spawned agent's run, the same way",
  swarm_cancel: "already carded by its tool-policy rule (confirm-swarm-cancel)",
  mission_delete: "already carded by its tool-policy rule (confirm-mission-delete)",
  self_edit: "the engine's own source under git (git is the undo); a card per self-repair is the friction it exists to remove",
  apply_update: "the update pipeline owns rollback",
};

/** Two-step forgets: the first call previews, only `confirm: true` deletes. */
const PREVIEWING_FORGETS = new Set(["memory_forget", "memory_forget_imports"]);
const USER_ASKED_TO_FORGET = /\b(forget|delete|erase|remove|wipe|scrub|purge)\b/i;

/** Why a non-shell tool call cannot be undone and needs its confirm, or null.
 *  `userText` is the human's latest message: a hard forget they asked for in
 *  their own words is theirs to have, with no second question. */
export function irreversibleToolReason(
  toolName: string,
  args: Record<string, unknown>,
  userText = "",
): string | null {
  if (!IRREVERSIBLE.has(toolName) || toolName in IRREVERSIBLE_TOOLS_UNCARDED) return null;
  if (PREVIEWING_FORGETS.has(toolName)) {
    if (args.confirm !== true) return null;
    if (USER_ASKED_TO_FORGET.test(userText)) return null;
  }
  return `irreversible tool (${toolName})`;
}
