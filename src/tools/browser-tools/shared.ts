/**
 * Shared helpers for the browser tool action handlers.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserEngine } from "../../browser/index.js";
import { wrapExternalContent } from "../../sanitize.js";
import { sensitivePageStub } from "../../browser/guards.js";
import { HUMAN_VERIFICATION_MESSAGE, snapshotShowsHumanVerification } from "../../browser/human-verification.js";


export function ok(content: string): ToolResult {
  return { content };
}

export function err(content: string): ToolResult {
  return { content, isError: true };
}

export const VALID_ENGINES: BrowserEngine[] = ["chromium", "firefox", "webkit"];

/**
 * Append a fresh post-action snapshot to a base result string. Mirrors what
 * the snapshot case does (external-content wrap) so the
 * agent sees the same thing it would after manually calling snapshot.
 *
 * Used by state-changing actions (fill, select, scroll, dialog, switch_tab)
 * that previously returned just the action's status line without any visibility
 * into what the page looks like afterward. Without this the agent had to
 * remember to chase every fill/select with a manual snapshot — and routinely
 * forgot, then guessed selectors from a stale DOM. Navigate/new_tab/click
 * already do this at the manager level; this brings the others in line.
 */
export async function appendPostActionSnapshot(
  manager: { snapshot: () => Promise<string>; getCurrentUrl?: () => string },
  base: string,
): Promise<string> {
  const stub = manager.getCurrentUrl ? sensitivePageStub(manager.getCurrentUrl()) : null;
  if (stub) return stub;
  try {
    const raw = await manager.snapshot();
    if (snapshotShowsHumanVerification(raw)) return `${base}\n\n${HUMAN_VERIFICATION_MESSAGE}`;
    const url = manager.getCurrentUrl ? manager.getCurrentUrl() : undefined;
    return `${base}\n\n--- Page snapshot ---\n${wrapExternalContent(raw, "browser.snapshot", url ? { url } : undefined)}`;
  } catch {
    return base;
  }
}

/**
 * Extract input-like refs from a formatted snapshot for fill-failure
 * diagnostics. The snapshot lines look like `[N]<role type=X>name</role>`;
 * we pull rows whose role suggests text-entry so the agent can pick the
 * right ref for a retry. Returns the first 8 matches, capped to keep the
 * error payload bounded.
 */
export function listInputRefs(snap: string): string {
  const inputRoles = /^\[\d+\]<(input|textbox|textarea|combobox|searchbox|spinbutton)\b/i;
  const matches = snap.split("\n").filter(l => inputRoles.test(l));
  if (matches.length === 0) return "(no input-like elements visible — call 'snapshot' to refresh)";
  return matches.slice(0, 8).join("\n");
}

