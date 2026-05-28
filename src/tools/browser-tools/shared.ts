/**
 * Shared helpers for the browser tool action handlers.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserEngine } from "../../browser.js";
import { wrapExternalContent } from "../../sanitize.js";

export function ok(content: string): ToolResult {
  return { content };
}

export function err(content: string): ToolResult {
  return { content, isError: true };
}

export const VALID_ENGINES: BrowserEngine[] = ["chromium", "firefox", "webkit"];

/**
 * Append a fresh post-action snapshot to a base result string. Mirrors what
 * the snapshot case does (auth-wall prefix + external-content wrap) so the
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
  manager: { snapshot: () => Promise<string> },
  base: string,
): Promise<string> {
  try {
    const raw = await manager.snapshot();
    const prefix = computeAuthWallPrefix(raw);
    return `${base}\n\n--- Page snapshot ---\n${wrapExternalContent(prefix + raw, "browser.snapshot")}`;
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

/**
 * Smarter auth-wall detection. Old heuristic flagged ANY page with a
 * `type=password` field, which fired false positives all over —
 * many sites have hidden / collapsed login forms that aren't actually
 * blocking the agent (e.g. ChatGPT signup link in nav, Grok's footer
 * sign-in option). Now we only flag when the password field looks
 * PRIMARY: it's near the top of the snapshot (within first 60 lines)
 * AND surrounded by other form elements (email/username/login-button
 * cues) suggesting it's the page's main interaction.
 *
 * False negatives (real auth wall not flagged) are recoverable — the
 * agent will still try to interact and the user will tell it to log in.
 * False positives (non-blocking password field flagged) cause Codex to
 * give up early, which is the user-reported regression.
 */
export function computeAuthWallPrefix(snapshot: string): string {
  const lines = snapshot.split("\n");
  const passwordIdx = lines.findIndex(l => /\btype=password\b/.test(l));
  if (passwordIdx === -1) return "";

  // Only consider it a primary auth wall if password field is in the first
  // 60 lines of the snapshot (above-the-fold approximation). Pages where
  // login is in a hidden modal or footer element won't match.
  if (passwordIdx > 60) return "";

  // Look for adjacent auth signals (email field, login button, sign-in
  // text within +/- 15 lines of the password field). Without these,
  // the password field is probably a stray element, not the page's
  // primary call to action.
  const start = Math.max(0, passwordIdx - 15);
  const end = Math.min(lines.length, passwordIdx + 15);
  const window = lines.slice(start, end).join("\n").toLowerCase();
  const hasEmailOrUsername = /\b(type=email|name=(email|username|user|login)|placeholder="?(email|username|user))\b/i.test(window);
  const hasLoginCta = /\b(sign in|log ?in|continue|submit|enter)\b/i.test(window);
  if (!hasEmailOrUsername && !hasLoginCta) return "";

  return `[AUTH-WALL DETECTED] This page has a primary login form. STOP. Tell the user what they need to log into and wait for them to handle it. Do NOT call more browser actions hoping to bypass it. Do NOT type passwords yourself — the user enters credentials in the browser themselves.\n\n`;
}
