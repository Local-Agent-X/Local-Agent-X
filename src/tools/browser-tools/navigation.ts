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

/** The new_tab URL list from args: a non-empty 'urls' array wins over 'url'. */
function newTabUrls(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.urls)) {
    const urls = args.urls.map((u) => String(u ?? "").trim()).filter((u) => u.length > 0);
    if (urls.length > 0) return urls;
  }
  const url = String(args.url || "");
  return url ? [url] : [];
}

export async function handleNewTab(
  manager: BrowserBackend,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const urls = newTabUrls(args);
  if (urls.length === 0) return err("'url' (or 'urls') parameter is required for new_tab action.");

  if (urls.length === 1) {
    // Single-URL path: today's exact behavior, byte for byte.
    const url = urls[0];
    log.info(`new_tab -> ${safeBrowserPageLabel(url)}`);
    const tabResult = await manager.newTab(url);
    const sensitive = sensitivePageStub(manager.getCurrentUrl());
    if (sensitive) return ok(sensitive);
    return ok(await appendPostActionSnapshot(manager, tabResult));
  }

  // Multi-URL fan-out — one tool call opens N tabs so multi-site opens are
  // deterministic regardless of model looping behavior. SEQUENTIAL on both
  // backends by design: the CDP manager mutates shared state per open
  // (context.newPage, this.page, bringToFront), and even on the in-app backend
  // (where per-viewId ops are independent) sequencing is what guarantees tab
  // order matches input order and that the active tab afterwards is the LAST
  // successfully opened one — the single tab we deep-snapshot. Concurrency
  // would race those invariants to save a few network round-trips.
  log.info(`new_tab x${urls.length} -> ${urls.map((u) => safeBrowserPageLabel(u)).join(", ")}`);
  const sections: string[] = [];
  let opened = 0;
  for (const [i, url] of urls.entries()) {
    const label = `[${i + 1}/${urls.length}] ${safeBrowserPageLabel(url)}`;
    try {
      // Per-URL isolation: one URL failing (nav error, HTTP ≥400, sensitive
      // stub) must not abort the others — record the row and keep going.
      const tabResult = await manager.newTab(url);
      const sensitive = sensitivePageStub(manager.getCurrentUrl());
      sections.push(`${label}\n${sensitive ?? tabResult}`);
      opened++;
    } catch (e) {
      sections.push(`${label}\nError: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const body = [`Opened ${opened} of ${urls.length} tabs.`, ...sections].join("\n\n");
  if (opened === 0) return err(body);
  // Deep-snapshot only the ACTIVE tab (the last successful open) — snapshotting
  // every tab would bury the per-URL report. A sensitive active page returns
  // the report without a snapshot rather than letting the stub replace it.
  if (sensitivePageStub(manager.getCurrentUrl())) return ok(body);
  return ok(await appendPostActionSnapshot(manager, body));
}

export async function handleSnapshot(manager: BrowserBackend): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  const raw = await manager.snapshot();
  const prefix = computeAuthWallPrefix(raw);
  return ok(wrapExternalContent(prefix + raw, "browser.snapshot"));
}
