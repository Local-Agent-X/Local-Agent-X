/**
 * Intelligent action handler (Stagehand-inspired). Takes a natural-language
 * instruction, reads the CURRENT structured observation, parses fill-vs-click
 * intent, finds the matching ref, and executes. Falls back to clickByText when
 * no ref matches.
 *
 * Resolution runs against manager.observe().currentRefs — the FULL live element
 * list, populated on every observation — NOT manager.snapshot(). snapshot()
 * returns a DIFF after the first observation ("+added/-removed/~changed" or
 * "Page unchanged since last observation"), so a stable element the user asks
 * to act on (e.g. an unchanged "Save" button) is absent from it once the page
 * has been observed once. Grepping the diff text is why act used to miss
 * elements that plainly exist; observe()'s currentRefs never has that hole.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserBackend } from "../../browser/index.js";
import type { DurableRef } from "../../browser/observation.js";
import { USER_TOOK_WHEEL } from "../../browser/in-app-actions.js";
import { ok, err } from "./shared.js";

// Roles that accept a typed value (fill intent) vs. roles that respond to a
// click. The click set is deliberately broad; anything it misses is caught by
// the clickByText fallback below, so a conservative filter never strands the
// user — it just routes to the text-based resolver.
const FILL_ROLES = new Set(["textbox", "searchbox", "combobox"]);
const CLICK_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "option",
  "menuitem", "menuitemcheckbox", "menuitemradio", "combobox", "listbox",
]);

// role + accessible name + type, lowercased — the text a target phrase is
// matched against. Mirrors what the old snapshot line carried (`<role type=X>
// name`), so type-driven matches like "email" → <textbox type=email> survive.
function haystack(r: DurableRef): string {
  return `${r.role} ${r.name} ${r.type}`.toLowerCase();
}

// Co-drive preemption: the in-app backend refused because the human is driving
// the view, signalled by the exact USER_TOOK_WHEEL text on the InteractionResult
// (backend.ts InteractionResult carries only { ok, text }). Stamp the ToolResult
// so applyProgressGuard resets the breaker instead of counting a preempted
// action as a stall.
function tagUserActive(result: ToolResult, interactionText: string): ToolResult {
  return interactionText === USER_TOOK_WHEEL
    ? { ...result, metadata: { ...result.metadata, userActive: true } }
    : result;
}

export async function handleAct(
  manager: BrowserBackend,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Natural language action: "click the login button", "fill in the search box with 'cats'"
  const instruction = String(args.text || args.value || "");
  if (!instruction) return err("'text' parameter required for act. Describe what to do: 'click the login button', 'fill search with cats'.");

  // Resolve against the FULL current element list, not snapshot()'s diff.
  const refs = (await manager.observe()).currentRefs;

  // Parse instruction to determine action type
  const lowerInst = instruction.toLowerCase();
  const isFill = /\b(fill|type|enter|input|write|set)\b/.test(lowerInst);
  const isClick = /\b(click|press|tap|select|choose|toggle|check|uncheck|submit|open)\b/.test(lowerInst);

  // Extract target text from instruction
  // "click the login button" → target = "login"
  // "fill email with test@test.com" → target = "email", value = "test@test.com"
  const words = instruction.replace(/['"]/g, "").split(/\s+/);

  if (isFill) {
    // Extract field name and value from instruction
    const withIdx = words.findIndex(w => w.toLowerCase() === "with");
    const fieldWords = words.slice(0, withIdx > 0 ? withIdx : words.length).filter(w => !/^(fill|type|enter|input|write|set|in|the|a|an)$/i.test(w));
    const valueWords = withIdx > 0 ? words.slice(withIdx + 1) : [];
    const fieldName = fieldWords.join(" ").toLowerCase();
    const fillValue = valueWords.join(" ") || String(args.value || "");

    // Find a matching input-like ref: at least one field word (>2 chars) in its name/role/type.
    const needles = fieldName.split(" ").filter(w => w.length > 2);
    const match = refs.find(r => FILL_ROLES.has(r.role) && needles.some(w => haystack(r).includes(w)));
    if (match) {
      const result = await manager.fillByRef(match.id, fillValue);
      return tagUserActive(result.ok
        ? ok(`Filled ref [${match.id}] with "${fillValue}". ${result.text}`)
        : err(`Failed to fill ref [${match.id}] with "${fillValue}". ${result.text}`), result.text);
    }
    return err(`Could not find input matching "${fieldName}". Observe the page to see available refs.`);
  }

  if (isClick) {
    // Find a matching clickable ref: every target word (>2 chars) in its name/role.
    const targetWords = words.filter(w => !/^(click|press|tap|select|choose|toggle|submit|open|the|a|an|on|button|link)$/i.test(w));
    const target = targetWords.join(" ").toLowerCase();

    const needles = target.split(" ").filter(w => w.length > 2);
    // A targetless click ("click the button") has no needles — [].every() is
    // vacuously true and would match an arbitrary element. Ask for a target
    // rather than clicking something random.
    if (needles.length === 0) return err(`Say what to click, e.g. "click the Save button".`);
    // Prefer a clickable-role ref; then fall back to ANY non-input ref whose
    // name/role matches every word. The fallback recovers clickables the role
    // set doesn't enumerate — icon buttons with an aria-label but no visible
    // text, treeitems, input[type=image] — which the old any-element match
    // clicked by ref and clickByText (visible-text only) cannot reach.
    const match =
      refs.find(r => CLICK_ROLES.has(r.role) && needles.every(w => haystack(r).includes(w))) ??
      refs.find(r => !FILL_ROLES.has(r.role) && needles.every(w => haystack(r).includes(w)));
    if (match) {
      const result = await manager.clickByRef(match.id);
      return tagUserActive(result.ok
        ? ok(`Clicked ref [${match.id}] (matched "${target}"). ${result.text}`)
        : err(`Failed to click ref [${match.id}] (matched "${target}"). ${result.text}`), result.text);
    }
    // Fallback: try click_text
    try {
      const result = await manager.clickByText(target);
      return tagUserActive(result.ok
        ? ok(`Clicked text "${target}". ${result.text}`)
        : err(`Could not click text "${target}". ${result.text}`), result.text);
    } catch {
      return err(`Could not find element matching "${target}". Observe the page to see available elements.`);
    }
  }

  return err(`Could not parse action from "${instruction}". Try: "click the X button" or "fill email with test@test.com".`);
}
