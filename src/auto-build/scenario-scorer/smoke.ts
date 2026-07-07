/**
 * Shared headless-smoke primitive for the scenario-scorer subsystem.
 *
 * "Open a URL in headless chromium, collect console + page errors, and decide
 * whether the page actually rendered anything" is needed in two places:
 *   - driver.ts drives a scenario step-by-step (this owns the per-step console
 *     bucketing).
 *   - the chunk-review build-exec gate loads a built artifact once and asks
 *     the single question "did it load clean and mount?".
 *
 * Both used to be (or would have been) separate chromium.launch + page.on
 * ("console") blocks that drift. This module is the one place that owns the
 * browser lifecycle + the "did it mount" heuristic. driver.ts composes the
 * lower-level {@link openPageWithConsoleCapture}; the gate uses the one-shot
 * {@link smokeUrl}.
 */

import { chromium, type Browser, type BrowserContext, type Page, type ConsoleMessage } from "playwright";

export interface OpenedPage {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Console errors + uncaught page errors, in arrival order. */
  errors: string[];
  close: () => Promise<void>;
}

/**
 * Launch headless chromium, open a page, and wire console-error + pageerror
 * capture into the returned `errors` array. Caller owns navigation and MUST
 * call `close()` (a finally block). Kept low-level so driver.ts can layer its
 * per-step bucketing on top via the same page object.
 */
export async function openPageWithConsoleCapture(): Promise<OpenedPage> {
  const errors: string[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") errors.push(msg.text().slice(0, 200));
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message.slice(0, 200)}`));

  const close = async () => {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  };
  return { browser, context, page, errors, close };
}

/**
 * Is a real mount point present AND carrying content? A game paints a sized
 * canvas; a framework app fills #root/#app/main; a plain page renders body
 * content. Runs inside Playwright's browser context via a selector-scoped
 * $$eval so the callback stays browser-typed (no DOM lib in the Node build).
 */
export async function pageMounted(page: Page): Promise<boolean> {
  return page.$$eval(
    "canvas, #root, #app, main, [data-root], body",
    (els) => {
      const nodes = els as unknown as Array<{
        tagName: string; width?: number; height?: number;
        childElementCount: number; textContent: string | null;
      }>;
      for (const el of nodes) {
        const tag = el.tagName.toLowerCase();
        if (tag === "canvas") {
          if ((el.width || 0) > 0 && (el.height || 0) > 0) return true;
          continue;
        }
        if (tag === "body") {
          if (el.childElementCount > 1 || (el.textContent || "").trim().length > 20) return true;
          continue;
        }
        if (el.childElementCount > 0 || (el.textContent || "").trim().length > 0) return true;
      }
      return false;
    },
  ).catch(() => false);
}

export interface SmokeResult {
  consoleErrors: string[];
  /** True when a root/canvas node mounted with content. */
  rootMounted: boolean;
  /** Set when navigation itself failed (page never opened). */
  loadError?: string;
  /** Set when a screenshot was requested AND captured. */
  screenshotPath?: string;
}

export interface SmokeOptions {
  /** Capture a PNG of the settled page to this path (Playwright creates the
   *  directory). Best-effort — a capture failure never fails the smoke. */
  screenshotPath?: string;
}

/**
 * One-shot smoke of a single URL: load it, wait a couple frames for
 * rAF/canvas paint, then report console errors + whether it mounted. Works
 * for both `file://` built artifacts and a running dev-server `http://` URL.
 */
export async function smokeUrl(url: string, loadTimeoutMs = 30_000, signal?: AbortSignal, opts?: SmokeOptions): Promise<SmokeResult> {
  if (signal?.aborted) return { consoleErrors: [], rootMounted: false, loadError: "aborted" };
  const opened = await openPageWithConsoleCapture();
  const capture = async (): Promise<string | undefined> => {
    if (!opts?.screenshotPath) return undefined;
    try {
      await opened.page.screenshot({ path: opts.screenshotPath, type: "png", fullPage: false });
      return opts.screenshotPath;
    } catch { return undefined; }
  };
  try {
    await opened.page.goto(url, { waitUntil: "load", timeout: loadTimeoutMs });
    await opened.page.waitForTimeout(500);
    if (signal?.aborted) return { consoleErrors: opened.errors, rootMounted: false, loadError: "aborted" };
    const rootMounted = await pageMounted(opened.page);
    return { consoleErrors: opened.errors, rootMounted, screenshotPath: await capture() };
  } catch (e) {
    return { consoleErrors: opened.errors, rootMounted: false, loadError: (e as Error).message.slice(0, 200), screenshotPath: await capture() };
  } finally {
    await opened.close();
  }
}
