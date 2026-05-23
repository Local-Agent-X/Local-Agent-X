/**
 * navigate / new_tab / snapshot — actions that bring a page into view and
 * surface its DOM. All three return a wrapped-external-content snapshot so the
 * agent gets immediate structural visibility without a follow-up call.
 */

import type { ToolResult } from "../types.js";
import type { BrowserManager, BrowserEngine } from "../browser.js";
import { wrapExternalContent } from "../sanitize.js";
import { dnsPinCheck } from "../browser/guards.js";
import { ok, err, computeAuthWallPrefix } from "./shared.js";

export async function handleNavigate(
  manager: BrowserManager,
  args: Record<string, unknown>,
  engine: BrowserEngine | undefined,
): Promise<ToolResult> {
  const url = String(args.url || "");
  if (!url) return err("'url' parameter is required for navigate action.");
  // DNS rebinding protection — resolve hostname before browser navigates
  const pinResult = await dnsPinCheck(url);
  if (pinResult) return err(pinResult);
  const navResult = await manager.navigate(url, engine);
  // Auto-snapshot on navigate. Without this, the agent has to
  // remember to call snapshot before fill/click/evaluate — which
  // it routinely forgets, leading to "Could not find input
  // matching X" errors and blind selector guesses. Bake the
  // snapshot into the navigate response so the agent sees the
  // DOM immediately. Same auth-wall + structural prefix logic
  // as the explicit snapshot action.
  try {
    const snap = await manager.snapshot();
    const prefix = computeAuthWallPrefix(snap);
    return ok(`${navResult}\n\n--- Page snapshot ---\n${wrapExternalContent(prefix + snap, "browser.snapshot")}`);
  } catch {
    // If snapshot fails (page still loading, etc.), return just
    // the nav result — agent can call snapshot manually next.
    return ok(navResult);
  }
}

export async function handleNewTab(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const url = String(args.url || "");
  if (!url) return err("'url' parameter is required for new_tab action.");
  const pinResult = await dnsPinCheck(url);
  if (pinResult) return err(pinResult);
  const tabResult = await manager.newTab(url);
  try {
    const snap = await manager.snapshot();
    const prefix = computeAuthWallPrefix(snap);
    return ok(`${tabResult}\n\n--- Page snapshot ---\n${wrapExternalContent(prefix + snap, "browser.snapshot")}`);
  } catch {
    return ok(tabResult);
  }
}

export async function handleSnapshot(manager: BrowserManager): Promise<ToolResult> {
  const raw = await manager.snapshot();
  const prefix = computeAuthWallPrefix(raw);
  return ok(wrapExternalContent(prefix + raw, "browser.snapshot"));
}
