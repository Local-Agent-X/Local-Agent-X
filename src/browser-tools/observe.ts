/**
 * observe — structured view of the page grouped by role (buttons, links,
 * inputs, dropdowns, checkboxes), viewport-first and diff-aware on repeat
 * calls.
 */

import type { ToolResult } from "../types.js";
import type { BrowserManager } from "../browser.js";
import { ok } from "./shared.js";

export async function handleObserve(manager: BrowserManager): Promise<ToolResult> {
  // Structured view grouped by role, viewport-first, diff-aware
  const obs = await manager.observe();
  const source = obs.isInitial && obs.full ? obs.full : [...obs.added];
  const visible = source.filter((r) => r.inViewport);

  const bucket = (names: string[]) => visible.filter((r) => names.includes(r.role));
  const buttons = bucket(["button"]);
  const links = bucket(["link"]);
  const inputs = bucket(["textbox", "searchbox", "combobox"]);
  const selects = bucket(["combobox", "listbox"]);
  const checks = bucket(["checkbox", "radio", "switch"]);

  const fmt = (r: { id: number; role: string; name: string }) =>
    `  [${r.id}] ${r.role} "${r.name.slice(0, 80)}"`;

  const parts: string[] = [];
  parts.push(`Page: ${obs.title} (${obs.url})`);
  parts.push(`${obs.totalCount} elements (${obs.totalCount - obs.offscreenCount} in viewport, ${obs.offscreenCount} below fold)`);
  if (!obs.isInitial) {
    parts.push(`Since last observation: +${obs.added.length} added, -${obs.removed.length} removed, ~${obs.changed.length} changed`);
  }
  parts.push("");
  parts.push(`Buttons (${buttons.length}):`, ...buttons.slice(0, 20).map(fmt));
  parts.push("", `Links (${links.length}):`, ...links.slice(0, 15).map(fmt));
  parts.push("", `Inputs (${inputs.length}):`, ...inputs.slice(0, 15).map(fmt));
  parts.push("", `Dropdowns (${selects.length}):`, ...selects.slice(0, 10).map(fmt));
  parts.push("", `Checkboxes/Radios (${checks.length}):`, ...checks.slice(0, 10).map(fmt));
  return ok(parts.join("\n"));
}
