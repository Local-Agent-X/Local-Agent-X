/**
 * navigate / new_tab / snapshot — actions that bring a page into view and
 * surface its DOM. All three return a wrapped-external-content snapshot so the
 * agent gets immediate structural visibility without a follow-up call.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserBackend, BrowserEngine } from "../../browser/index.js";
import { wrapExternalContent } from "../../sanitize.js";
import { createLogger } from "../../logger.js";
import { ok, err, computeAuthWallPrefix, appendPostActionSnapshot } from "./shared.js";
import { safeBrowserPageLabel, sensitivePageStub } from "../../browser/guards.js";

// Navigations were invisible in the logs — only browser *spawns* logged, never
// where the agent went. That made route-arounds (X login wall -> navigate to a
// different source) impossible to see without excavating the per-op record.
// One line per navigate turns the whole browse trail into a greppable story.
const log = createLogger("browser.nav");

export async function handleNavigate(
  manager: BrowserBackend,
  args: Record<string, unknown>,
  engine: BrowserEngine | undefined,
): Promise<ToolResult> {
  const url = String(args.url || "");
  if (!url) return err("'url' parameter is required for navigate action.");
  log.info(`navigate -> ${safeBrowserPageLabel(url)}`);
  const navResult = await manager.navigate(url, engine);
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return ok(sensitive);
  // Auto-snapshot on navigate. Without this, the agent has to remember to call
  // snapshot before fill/click/evaluate — which it routinely forgets, leading
  // to "Could not find input matching X" errors and blind selector guesses.
  // appendPostActionSnapshot bakes the same auth-wall + structural prefix the
  // explicit snapshot action uses, and falls back to the bare nav result if the
  // page is still loading.
  return ok(await appendPostActionSnapshot(manager, navResult));
}

export async function handleNewTab(
  manager: BrowserBackend,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const url = String(args.url || "");
  if (!url) return err("'url' parameter is required for new_tab action.");
  log.info(`new_tab -> ${safeBrowserPageLabel(url)}`);
  const tabResult = await manager.newTab(url);
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return ok(sensitive);
  return ok(await appendPostActionSnapshot(manager, tabResult));
}

export async function handleSnapshot(manager: BrowserBackend): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  const raw = await manager.snapshot();
  const prefix = computeAuthWallPrefix(raw);
  return ok(wrapExternalContent(prefix + raw, "browser.snapshot"));
}
