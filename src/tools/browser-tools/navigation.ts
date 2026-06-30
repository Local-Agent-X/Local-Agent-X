/**
 * navigate / new_tab / snapshot — actions that bring a page into view and
 * surface its DOM. All three return a wrapped-external-content snapshot so the
 * agent gets immediate structural visibility without a follow-up call.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserManager, BrowserEngine } from "../../browser/index.js";
import { wrapExternalContent } from "../../sanitize.js";
import { dnsPinCheck } from "../../browser/guards.js";
import { createLogger } from "../../logger.js";
import { ok, err, computeAuthWallPrefix, appendPostActionSnapshot } from "./shared.js";

// Navigations were invisible in the logs — only browser *spawns* logged, never
// where the agent went. That made route-arounds (X login wall -> navigate to a
// different source) impossible to see without excavating the per-op record.
// One line per navigate turns the whole browse trail into a greppable story.
const log = createLogger("browser.nav");

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
  log.info(`navigate -> ${url}`);
  const navResult = await manager.navigate(url, engine);
  // Auto-snapshot on navigate. Without this, the agent has to remember to call
  // snapshot before fill/click/evaluate — which it routinely forgets, leading
  // to "Could not find input matching X" errors and blind selector guesses.
  // appendPostActionSnapshot bakes the same auth-wall + structural prefix the
  // explicit snapshot action uses, and falls back to the bare nav result if the
  // page is still loading.
  return ok(await appendPostActionSnapshot(manager, navResult));
}

export async function handleNewTab(
  manager: BrowserManager,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const url = String(args.url || "");
  if (!url) return err("'url' parameter is required for new_tab action.");
  const pinResult = await dnsPinCheck(url);
  if (pinResult) return err(pinResult);
  log.info(`new_tab -> ${url}`);
  const tabResult = await manager.newTab(url);
  return ok(await appendPostActionSnapshot(manager, tabResult));
}

export async function handleSnapshot(manager: BrowserManager): Promise<ToolResult> {
  const raw = await manager.snapshot();
  const prefix = computeAuthWallPrefix(raw);
  return ok(wrapExternalContent(prefix + raw, "browser.snapshot"));
}
