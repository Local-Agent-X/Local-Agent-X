/**
 * click / click_text / fill / select / scroll — element-targeted interactions.
 * fill and the post-action variants share the listInputRefs / appendPostActionSnapshot
 * helpers from shared.ts.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserManager } from "../../browser/index.js";
import { ok, err, appendPostActionSnapshot, listInputRefs } from "./shared.js";

export async function handleClick(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Prefer ref (from snapshot) over CSS selector
  if (args.ref !== undefined && args.ref !== null) {
    const ref = Number(args.ref);
    if (isNaN(ref)) return err("'ref' must be a number from the snapshot.");
    return ok(await manager.clickByRef(ref));
  }
  const selector = String(args.selector || "");
  if (!selector) return err("Provide 'ref' (from snapshot) or 'selector' (CSS) for click.");
  return ok(await manager.click(selector));
}

export async function handleClickText(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const text = String(args.text || "");
  if (!text) return err("'text' parameter is required for click_text action.");
  return ok(await manager.clickByText(text));
}

export async function handleFill(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const value = String(args.value ?? "");
  // No auto-snapshot here. Filling an input writes characters into
  // a box — the page's structural DOM almost never changes, so
  // appending a fresh snapshot after every fill (a) costs a full
  // extract+iframe-traversal per call and (b) bloats the conversation
  // with redundant ref lists that match what the agent already saw.
  // For a 16-line PO that's 16×(name+qty+price)=48+ wasted snapshots.
  // The agent can call 'snapshot' explicitly when it expects a typing
  // response (autocomplete dropdown, type-ahead suggestions, etc.).
  // Live regression: the customer PO-entry workflow that took <10min before
  // commit 0d4df8f ran 30+min after auto-snapshot was added to fill.
  if (args.ref !== undefined && args.ref !== null) {
    const ref = Number(args.ref);
    if (isNaN(ref)) return err("'ref' must be a number from the snapshot.");
    return ok(await manager.fillByRef(ref, value));
  }
  const selector = String(args.selector || "");
  if (!selector) return err("Provide 'ref' (from snapshot) or 'selector' (CSS) for fill.");
  try {
    return ok(await manager.fill(selector, value));
  } catch (e) {
    // Don't blind-guess with hardcoded selectors — that silently
    // fills the wrong input when the page happens to have a matching
    // generic shape. List the actual inputs on the page so the agent
    // can retry with a real ref.
    const snap = await manager.snapshot().catch(() => "");
    const inputs = listInputRefs(snap);
    const reason = (e as Error).message?.split("\n")[0] || "fill failed";
    return err(
      `fill failed for "${selector}": ${reason}\n` +
      `Inputs currently on the page (retry with 'ref' from this list):\n${inputs}`,
    );
  }
}

export async function handleSelect(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const selector = String(args.selector || "");
  const value = String(args.value || "");
  if (!selector || !value) return err("'selector' and 'value' are required for select action.");
  const base = await manager.select(selector, value);
  return ok(await appendPostActionSnapshot(manager, base));
}

export async function handleScroll(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // value = "up" | "down" | "top" | "bottom" | "<number>" (for refId)
  // OR ref = number to scroll that element into view
  const refVal = args.ref !== undefined && args.ref !== null ? Number(args.ref) : undefined;
  const direction = args.value ? String(args.value) as "up" | "down" | "top" | "bottom" : "down";
  const base = await manager.scroll({ direction, refId: refVal });
  return ok(await appendPostActionSnapshot(manager, base));
}
