/**
 * Wait until the page has settled before snapshotting.
 *
 * Settled = networkidle (Playwright) AND no DOM child-list mutations for
 * `domStableMs` AND no visible loading spinners. We never wait past `maxWait`
 * — better to act on a partial render than to time out the agent's turn.
 *
 * Why only childList+subtree (no attributes/characterData)? Animated counters,
 * clocks, and CSS transitions emit constant attribute/text mutations and would
 * never let us settle. Structural changes are what actually change "what is
 * clickable", which is all the agent cares about.
 */
import type { Page } from "playwright";

export interface StabilityOptions {
  /** Max wait in ms. Default 3000. */
  maxWait?: number;
  /** Network-idle window in ms. Default 500. */
  networkIdleMs?: number;
  /** DOM-mutation-quiet window in ms. Default 500. */
  domStableMs?: number;
  /** Skip the wait entirely (caller knows the page is ready). */
  skip?: boolean;
}

export async function waitForStability(page: Page, opts: StabilityOptions = {}): Promise<void> {
  if (opts.skip) return;
  const maxWait = opts.maxWait ?? 3000;
  const networkIdleMs = opts.networkIdleMs ?? 500;
  const domStableMs = opts.domStableMs ?? 500;
  const start = Date.now();

  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(networkIdleMs * 3, maxWait / 2) });
  } catch {
    // SPAs with long-polling never reach networkidle — keep going.
  }

  const remaining = maxWait - (Date.now() - start);
  if (remaining <= 0) return;

  const domScript = `
    (() => new Promise((resolve) => {
      const STABLE = ${domStableMs};
      const CAP = ${remaining};
      const begin = Date.now();
      let timer = null;
      let observer = null;
      const finish = () => {
        try { if (observer) observer.disconnect(); } catch {}
        if (timer) clearTimeout(timer);
        resolve(true);
      };
      const reset = () => {
        if (timer) clearTimeout(timer);
        if (Date.now() - begin >= CAP) return finish();
        timer = setTimeout(finish, STABLE);
      };
      try {
        observer = new MutationObserver(reset);
        observer.observe(document.documentElement, { childList: true, subtree: true });
      } catch { return finish(); }
      reset();
      setTimeout(finish, CAP);
    }))()
  `;
  await page.evaluate(domScript).catch(() => {});

  const remaining2 = maxWait - (Date.now() - start);
  if (remaining2 <= 0) return;

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
      { timeout: remaining2, polling: 150 }
    );
  } catch {
    // Timed out — return control and let the caller proceed with what's there.
  }
}
