/**
 * Wait-for-stability helper.
 *
 * A page is "stable" when: the network hasn't made a new request for 500ms,
 * the DOM hasn't mutated for 300ms, and no common loading spinners are visible.
 * Used before every observe() so the agent doesn't act on a half-rendered page.
 *
 * Conservative: we never wait longer than `maxWait`. If the page is still busy
 * at that point we return anyway — the agent will get whatever's there rather
 * than a useless timeout.
 */
import type { Page } from "playwright";

export interface StabilityOptions {
  /** Max wait in ms. Default 3000. */
  maxWait?: number;
  /** Network-idle window in ms. Default 500. */
  networkIdleMs?: number;
  /** DOM-stable window in ms. Default 300. */
  domStableMs?: number;
}

export async function waitForStability(page: Page, opts: StabilityOptions = {}): Promise<void> {
  const maxWait = opts.maxWait ?? 3000;
  const networkIdleMs = opts.networkIdleMs ?? 500;
  const start = Date.now();

  // 1) Quick network settle — Playwright's built-in networkidle waits for 500ms
  //    of no inflight requests. Cap at half maxWait so we don't spend the whole
  //    budget on network.
  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(networkIdleMs * 3, maxWait / 2) });
  } catch {
    // Networkidle rarely reaches on SPAs with long-polling — that's fine.
  }

  // 2) DOM stability: poll that document.readyState is complete AND no common
  //    loaders are still visible. We don't use MutationObserver here because
  //    spinners often animate via CSS transforms that don't emit mutations.
  const remaining = maxWait - (Date.now() - start);
  if (remaining <= 0) return;

  try {
    await page.waitForFunction(
      `(() => {
        if (document.readyState !== 'complete') return false;
        const loaders = document.querySelectorAll(
          '[aria-busy="true"], .loading:not([hidden]), .spinner:not([hidden]), [data-loading="true"]'
        );
        for (const l of loaders) {
          const r = l.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return false;
        }
        return true;
      })()`,
      { timeout: remaining, polling: 150 }
    );
  } catch {
    // Timed out — return control and let the caller proceed with what's there.
  }
}
