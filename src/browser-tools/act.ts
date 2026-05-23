/**
 * Intelligent action handler (Stagehand-inspired). Takes a natural-language
 * instruction, takes a fresh snapshot, parses fill-vs-click intent, finds the
 * matching ref, and executes. Falls back to clickByText when no ref matches.
 */

import type { ToolResult } from "../types.js";
import type { BrowserManager } from "../browser.js";
import { ok, err } from "./shared.js";

export async function handleAct(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Natural language action: "click the login button", "fill in the search box with 'cats'"
  const instruction = String(args.text || args.value || "");
  if (!instruction) return err("'text' parameter required for act. Describe what to do: 'click the login button', 'fill search with cats'.");

  // Get current page state
  const snap = await manager.snapshot();
  const lines = snap.split("\n").filter(l => l.trim());

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

    // Find matching ref in snapshot
    const match = lines.find(l => {
      const lower = l.toLowerCase();
      return (lower.includes("input") || lower.includes("textbox") || lower.includes("combobox") || lower.includes("searchbox")) &&
             fieldName.split(" ").some(w => w.length > 2 && lower.includes(w));
    });
    if (match) {
      const refMatch = match.match(/\[(\d+)\]/);
      if (refMatch) {
        const ref = parseInt(refMatch[1]);
        const result = await manager.fillByRef(ref, fillValue);
        return ok(`Filled ref [${ref}] with "${fillValue}". ${result}`);
      }
    }
    // Fallback: try click_text on the field label, then fill
    return err(`Could not find input matching "${fieldName}". Take a snapshot to see available refs.`);
  }

  if (isClick) {
    // Find matching element in snapshot
    const targetWords = words.filter(w => !/^(click|press|tap|select|choose|toggle|submit|open|the|a|an|on|button|link)$/i.test(w));
    const target = targetWords.join(" ").toLowerCase();

    const match = lines.find(l => {
      const lower = l.toLowerCase();
      return target.split(" ").filter(w => w.length > 2).every(w => lower.includes(w));
    });
    if (match) {
      const refMatch = match.match(/\[(\d+)\]/);
      if (refMatch) {
        const ref = parseInt(refMatch[1]);
        const result = await manager.clickByRef(ref);
        return ok(`Clicked ref [${ref}] (matched "${target}"). ${result}`);
      }
    }
    // Fallback: try click_text
    try {
      const result = await manager.clickByText(target);
      return ok(`Clicked text "${target}". ${result}`);
    } catch {
      return err(`Could not find element matching "${target}". Take a snapshot to see available elements.`);
    }
  }

  return err(`Could not parse action from "${instruction}". Try: "click the X button" or "fill email with test@test.com".`);
}
