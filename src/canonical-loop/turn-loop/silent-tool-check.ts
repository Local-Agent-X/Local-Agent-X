import type { ToolCall } from "../contract-types.js";
import { isMemoryWrite, loopFactsOf } from "../../tool-registry.js";

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
 *
 * Silent by row: a fire-and-forget UI tool (`loop.silent` — a voice turn that
 * morphed the sphere drove a wrap-up and re-spoke its reply) and a memory
 * write (`memoryWrite`). turn-loop/tool-failure-summary.ts reads the same
 * memoryWrite fact for the termination question, one fact for two decisions:
 * a row that declares it but DOES return data would suppress its wrap-up turn
 * in both places.
 */

const SILENT_BROWSER_ACTIONS = new Set([
  "navigate", "new_tab", "close", "switch_tab", "close_tab", "back", "forward", "reload",
  "click", "type", "scroll", "focus", "hover", "press_key", "select",
]);

export function isSilentToolCall(c: ToolCall): boolean {
  if (loopFactsOf(c.tool).silent === true || isMemoryWrite(c.tool)) return true;
  if (c.tool === "browser") {
    const action = (c.args as { action?: string } | null)?.action;
    return typeof action === "string" && SILENT_BROWSER_ACTIONS.has(action);
  }
  return false;
}
