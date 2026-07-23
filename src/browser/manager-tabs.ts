/**
 * CDP tab lifecycle — new_tab open/unwind and close_tab — split from
 * manager.ts for the 400-LOC ceiling, same accessor-host pattern as
 * manager-popups.ts: BrowserManager stays the single owner of `owned` and
 * `page`; these functions drive the lifecycle through narrow accessors so no
 * tab state is duplicated outside the manager.
 */
import type { Page } from "playwright";
import { NAV_TIMEOUT } from "./launcher.js";
import { injectTokenIfLocal } from "./auth-context.js";
import { safeHost, redirectMessage } from "./redirect.js";
import { safeBrowserPageLabel, sensitivePageStub } from "./guards.js";
import { waitForContinuityCacheRestore } from "./continuity-cache.js";
import type { BrowserMode } from "../types.js";

/** The manager state these lifecycle ops read/mutate. `isOwned`/`removeOwned`
 *  act on the RAW owned array (closed pages included) — the unwind path must
 *  find a page that already self-closed; `listOwnedPages` is the live view. */
export interface CdpTabHost {
  mode(): BrowserMode;
  /** Materializes the context + first page (BrowserManager.getPage). */
  ensureContext(): Promise<void>;
  newPage(): Promise<Page>;
  adoptPage(p: Page): Page;
  listOwnedPages(): Page[];
  isOwned(p: Page): boolean;
  addOwned(p: Page): void;
  removeOwned(p: Page): void;
  getActive(): Page | null;
  setActive(p: Page | null): void;
}

/** The withheld-or-plain tab label the close report prints (matches the
 *  listTabs row family). Title read is best-effort — a dying page must not
 *  fail the close that is removing it. */
async function tabLabel(page: Page): Promise<string> {
  const url = page.url();
  if (sensitivePageStub(url)) return "[sensitive page withheld]";
  const title = await page.title().catch(() => "");
  return `${title || "(no title)"} — ${url}`;
}

/** Open a new owned tab on the manager's context (the `new_tab` action).
 *  Any failure AFTER the page is created — goto (DNS/timeout/egress-abort),
 *  continuity restore, or a page that self-closes on an OAuth/redirect bounce
 *  before bringToFront/title — unwinds the just-pushed page so it never
 *  strands in `owned`, and the active page is never left pointing at a dead
 *  tab. Same HTTP ≥400 guard as navigate(): an error page is a thrown
 *  failure, not a "Status: 404" success. */
export async function openCdpTab(host: CdpTabHost, url: string): Promise<string> {
  url = injectTokenIfLocal(url);
  await host.ensureContext();
  const requestedHost = safeHost(url);
  const newPage = host.adoptPage(await host.newPage());
  host.addOwned(newPage);
  const unwind = async () => {
    host.removeOwned(newPage);
    if (host.getActive() === newPage) host.setActive(null);
    try { await newPage.close(); } catch { /* already closed */ }
  };
  try {
    const response = await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    if (host.mode() === "continuity") await waitForContinuityCacheRestore(newPage);
    const status = response?.status() ?? "unknown";
    if (typeof status === "number" && status >= 400) {
      const failedUrl = newPage.url();
      await unwind();
      throw new Error(`Navigation failed: HTTP ${status} (${safeBrowserPageLabel(failedUrl)})`);
    }
    const sensitive = sensitivePageStub(newPage.url());
    try { await newPage.waitForLoadState("load", { timeout: 5000 }); } catch { /* load timeout ok */ }
    await newPage.waitForTimeout(1000);
    host.setActive(newPage);
    await newPage.bringToFront();
    if (sensitive) return sensitive;
    const title = await newPage.title();
    const tabCount = host.listOwnedPages().length;
    const redirect = redirectMessage(requestedHost, safeHost(newPage.url()));
    return `Opened new tab (${tabCount} tabs total)\nURL: ${newPage.url()}\nStatus: ${status}\nTitle: ${title}${redirect}`;
  } catch (error) {
    if (host.isOwned(newPage)) await unwind();
    throw error;
  }
}

/** Close ONE owned tab by its `tabs` index (the `close_tab` action). The last
 *  remaining tab is refused — that is the whole session ending, which is
 *  `close`'s job. Closing the active tab activates the tab that slid into its
 *  slot (or the new last one), Chrome-style, and brings it to front. */
export async function closeCdpTab(host: CdpTabHost, index: number): Promise<string> {
  const pages = host.listOwnedPages();
  if (pages.length === 0) return "No browser session active.";
  if (index < 0 || index >= pages.length) {
    return `Invalid tab index ${index}. Use 'tabs' action to see available tabs (0-${pages.length - 1}).`;
  }
  if (pages.length === 1) {
    return `Tab [${index}] is the session's only tab — close_tab can't remove it. Use 'close' to end the whole browser session.`;
  }
  const page = pages[index];
  const label = await tabLabel(page);
  const wasActive = host.getActive() === page;
  try { await page.close(); } catch { /* already closed */ }
  host.removeOwned(page);
  if (!wasActive) return `Closed tab [${index}]: ${label}`;
  const rest = host.listOwnedPages();
  const next = rest[Math.min(index, rest.length - 1)] ?? null;
  host.setActive(next);
  if (!next) return `Closed tab [${index}]: ${label}`;
  try { await next.bringToFront(); } catch { /* focus is best-effort */ }
  return `Closed tab [${index}]: ${label}\nActive tab is now: ${await tabLabel(next)}`;
}
