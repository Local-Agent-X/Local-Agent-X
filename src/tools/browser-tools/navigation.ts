/**
 * navigate / new_tab / snapshot — actions that bring a page into view and
 * surface its DOM. All three return a wrapped-external-content snapshot so the
 * agent gets immediate structural visibility without a follow-up call.
 */

import type { ToolResult } from "../../types.js";
import type { BrowserBackend, BrowserEngine } from "../../browser/index.js";
import { ObservationRegistry, type BrowserObservation } from "../../browser/observation.js";
import { wrapExternalContent } from "../../sanitize.js";
import { createLogger } from "../../logger.js";
import { ok, err, computeAuthWallPrefix, appendPostActionSnapshot } from "./shared.js";
import { safeBrowserPageLabel, sensitivePageStub } from "../../browser/guards.js";
import { resolveNewTabUrls } from "../../security/layer/browser-egress-eval.js";
import { getToolTimeout } from "../../tool-execution/tool-timeout.js";
import { BROWSER_TOOL_NAME } from "./description.js";

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

/** Test seam for the multi-URL budget: an injectable clock and timeout source.
 *  Both default to the production values (Date.now / the canonical browser tool
 *  timeout via getToolTimeout) so the real call site (index.ts) passes nothing
 *  and behavior is unchanged; the test overrides them to drive the budget
 *  deterministically without sleeping. */
export interface NewTabBudgetDeps {
  now?: () => number;
  toolTimeoutMs?: number;
}

export async function handleNewTab(
  manager: BrowserBackend,
  args: Record<string, unknown>,
  deps: NewTabBudgetDeps = {},
): Promise<ToolResult> {
  const resolved = resolveNewTabUrls(args);
  if (resolved.error) return err(resolved.error);
  const urls = resolved.urls;
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
  //
  // Wedge-resilience: N sequential opens (each up to ~25s desktop-side) can
  // outrun the browser tool's in-process wedge deadline (index.ts fires
  // resetWedgedBrowser at ~toolMs-1s, which DROPS every tab this call already
  // opened, then tells the agent to "retry" — so a 10-URL call re-wedges
  // forever). The loop therefore carries a time budget from the SAME canonical
  // timeout (getToolTimeout) and stops STARTING new tabs once it has burned
  // ~70% of it: it RETURNS the tabs it did open, under the deadline, with a
  // partial report naming what it skipped — instead of running past the
  // deadline and getting force-recovered. Per-URL errors still don't abort.
  const now = deps.now ?? Date.now;
  const toolMs = deps.toolTimeoutMs ?? getToolTimeout(BROWSER_TOOL_NAME);
  // Mirror index.ts's wedge deadline (Math.max(1000, toolMs-1000)). toolMs<=0
  // means the operator set the tool unbounded — the wedge disarms too, so run
  // the whole batch (Infinity budget, no early stop).
  const budgetMs = toolMs > 0 ? Math.max(1_000, toolMs - 1_000) : 0;
  // Stop STARTING tabs past 70% of the budget so the last in-flight open still
  // has headroom to finish before the wedge deadline fires.
  const stopStartingAt = budgetMs > 0 ? budgetMs * 0.7 : Infinity;
  const startedAt = now();

  log.info(`new_tab x${urls.length} -> ${urls.map((u) => safeBrowserPageLabel(u)).join(", ")}`);
  const sections: string[] = [];
  let opened = 0;
  let stoppedAt = -1;
  for (const [i, url] of urls.entries()) {
    // Budget gate: always attempt the first URL, then stop opening further tabs
    // once the headroom is spent. Already-opened tabs stay captured in
    // `sections`; the rest are reported below as not-attempted so the agent can
    // finish them in a follow-up call rather than losing this call to the wedge.
    if (i > 0 && now() - startedAt >= stopStartingAt) {
      stoppedAt = i;
      break;
    }
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
  let summary = `Opened ${opened} of ${urls.length} tabs.`;
  if (stoppedAt !== -1) {
    const notAttempted = urls.slice(stoppedAt);
    summary +=
      ` Stopped early to stay within the browser time budget — ${notAttempted.length} URL(s) not attempted: ` +
      `${notAttempted.map((u) => safeBrowserPageLabel(u)).join(", ")}. ` +
      `Open the rest in a follow-up new_tab call.`;
  }
  const body = [summary, ...sections].join("\n\n");
  if (opened === 0) return err(body);
  // Deep-snapshot only the ACTIVE tab (the last successful open) — snapshotting
  // every tab would bury the per-URL report. A sensitive active page returns
  // the report without a snapshot rather than letting the stub replace it.
  if (sensitivePageStub(manager.getCurrentUrl())) return ok(body);
  return ok(await appendPostActionSnapshot(manager, body));
}

export async function handleSnapshot(
  manager: BrowserBackend,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const sensitive = sensitivePageStub(manager.getCurrentUrl());
  if (sensitive) return { content: sensitive, status: "blocked", isError: true, metadata: { browserStatus: "sensitive-content-withheld" } };
  let raw: string;
  if (args.full === true) {
    // Force a complete re-list. The diff protocol has no other way to
    // re-request the full element list — after context compaction (or once
    // the original full list scrolled out of the agent's window) the diffs
    // reference refs the agent can no longer see. Reshaping the observation
    // as initial re-prints every current ref; the registry's diff baseline
    // advances exactly as on a normal observe, so later snapshots keep
    // diffing correctly.
    const obs = await manager.observe();
    const forced: BrowserObservation = { ...obs, isInitial: true, full: obs.currentRefs, added: [], removed: [], changed: [] };
    raw = ObservationRegistry.format(forced);
  } else {
    raw = await manager.snapshot();
  }
  const prefix = computeAuthWallPrefix(raw);
  return ok(wrapExternalContent(prefix + raw, "browser.snapshot"));
}
