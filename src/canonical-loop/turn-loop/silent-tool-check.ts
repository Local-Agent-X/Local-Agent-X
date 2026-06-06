import type { ToolCall } from "../contract-types.js";

/**
 * Tool calls whose side effect is visible to the user without a follow-up
 * narration turn. When EVERY tool call in a turn is silent and the model
 * already produced user-facing text alongside the call, the turn loop
 * short-circuits so the model doesn't drive a wrap-up turn ("X is saved",
 * "Chrome is on PH0 — no blocker", etc.). The activity row is the receipt.
 *
 * Data-returning tools (screenshot, evaluate, web_fetch, bash, etc.) are
 * NOT silent — the model legitimately needs the next turn to interpret
 * the result.
 */

// Fire-and-forget tools whose entire effect is a UI side-effect with no result
// the model needs to read back. Without this, a voice turn that morphs the
// sphere (voice_visual) was treated as needing a follow-up turn — the model
// re-spoke its reply, so the user heard/saw it twice.
const SILENT_FIRE_AND_FORGET_TOOLS = new Set([
  "voice_visual",
]);

const MEMORY_WRITE_TOOLS = new Set([
  "remember",
  "update_fact",
  "forget",
  "memory_save",
  "memory_set_user_field",
  "memory_update_profile",
]);

const SILENT_BROWSER_ACTIONS = new Set([
  "navigate", "new_tab", "close", "switch_tab", "back", "forward", "reload",
  "click", "type", "scroll", "focus", "hover", "press_key", "select",
]);

export function isSilentToolCall(c: ToolCall): boolean {
  if (SILENT_FIRE_AND_FORGET_TOOLS.has(c.tool)) return true;
  if (MEMORY_WRITE_TOOLS.has(c.tool)) return true;
  if (c.tool === "browser") {
    const action = (c.args as { action?: string } | null)?.action;
    return typeof action === "string" && SILENT_BROWSER_ACTIONS.has(action);
  }
  return false;
}
