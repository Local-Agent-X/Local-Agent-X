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
  /** Uncaught page errors ONLY (subset of `errors`) — the hard signal a
   *  framework-tier gate keys on while tolerating dev-server console noise. */
  pageErrors: string[];
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
  const pageErrors: string[] = [];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") errors.push(msg.text().slice(0, 200));
  });
  page.on("pageerror", (err) => {
    const entry = `pageerror: ${err.message.slice(0, 200)}`;
    errors.push(entry);
    pageErrors.push(entry);
  });

  const close = async () => {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  };
  return { browser, context, page, errors, pageErrors, close };
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
  /** Uncaught page errors ONLY (subset of consoleErrors). */
  pageErrors: string[];
  /** True when a root/canvas node mounted with content. */
  rootMounted: boolean;
  /** Set when navigation itself failed (page never opened). */
  loadError?: string;
  /** Set when a screenshot was requested AND captured. */
  screenshotPath?: string;
  /** Present when `interact` was requested AND the initial load was clean. */
  interaction?: SmokeInteraction;
}

/**
 * Second smoke phase: click the page's primary action and re-observe. A page
 * whose breakage hides behind its Start button passes the load-time checks —
 * this phase is what walks through that door.
 */
export interface SmokeInteraction {
  /** False when no clickable primary action existed (a static page is not a failure). */
  clicked: boolean;
  /** Console + page errors that arrived AFTER the click only. */
  consoleErrors: string[];
  /** Uncaught page errors that arrived AFTER the click only (subset of consoleErrors). */
  pageErrors: string[];
  rootMounted: boolean;
  /** Set when a post-interaction screenshot was requested AND captured. */
  screenshotPath?: string;
}

export interface SmokeOptions {
  /** Capture a PNG of the settled page to this path (Playwright creates the
   *  directory). Best-effort — a capture failure never fails the smoke. */
  screenshotPath?: string;
  /** After a CLEAN initial load, click the primary action (semantic button
   *  role — <button>, [role=button], input[type=submit|button]), wait a beat
   *  for rAF/canvas paint, and re-observe. Skipped when the initial load
   *  already failed — phase 2 evidence would just repeat phase 1's. */
  interact?: { screenshotPath?: string };
}

/**
 * One-shot smoke of a single URL: load it, wait a couple frames for
 * rAF/canvas paint, then report console errors + whether it mounted. Works
 * for both `file://` built artifacts and a running dev-server `http://` URL.
 */
export async function smokeUrl(url: string, loadTimeoutMs = 30_000, signal?: AbortSignal, opts?: SmokeOptions): Promise<SmokeResult> {
  if (signal?.aborted) return { consoleErrors: [], pageErrors: [], rootMounted: false, loadError: "aborted" };
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
    if (signal?.aborted) return { consoleErrors: opened.errors, pageErrors: opened.pageErrors, rootMounted: false, loadError: "aborted" };
    const rootMounted = await pageMounted(opened.page);
    // Snapshot phase-1 errors BEFORE any interaction — opened.errors is live,
    // and post-click errors must land in interaction.consoleErrors, not here.
    const result: SmokeResult = {
      consoleErrors: opened.errors.slice(),
      pageErrors: opened.pageErrors.slice(),
      rootMounted,
      screenshotPath: await capture(),
    };
    // Interact whenever the HARD signals are clean (mounted, no uncaught
    // errors). Console chatter doesn't block the click: strict-mode callers
    // fail on it before ever reading the interaction, and hard-signals
    // callers tolerate it by design.
    if (opts?.interact && rootMounted && result.pageErrors.length === 0 && !signal?.aborted) {
      result.interaction = await clickPrimaryAndResmoke(opened, opts.interact);
    }
    return result;
  } catch (e) {
    return { consoleErrors: opened.errors, pageErrors: opened.pageErrors, rootMounted: false, loadError: (e as Error).message.slice(0, 200), screenshotPath: await capture() };
  } finally {
    await opened.close();
  }
}

/** Post-click settle window — same rAF/canvas-paint reasoning as the 500ms
 *  load settle, a touch longer because a Start click typically boots a render
 *  loop rather than just painting static DOM. */
const INTERACT_SETTLE_MS = 800;
const CLICK_TIMEOUT_MS = 5_000;

async function clickPrimaryAndResmoke(
  opened: OpenedPage,
  opts: { screenshotPath?: string },
): Promise<SmokeInteraction> {
  const { page, errors, pageErrors } = opened;
  const preClickErrorCount = errors.length;
  const preClickPageErrorCount = pageErrors.length;
  try {
    // getByRole("button") is the same semantic-locator family the scenario
    // driver resolves steps with: <button>, [role=button], input submit/button.
    await page.getByRole("button").first().click({ timeout: CLICK_TIMEOUT_MS });
  } catch {
    // No button, or it isn't clickable (hidden, detached). Not a failure —
    // plenty of legitimate apps have no primary action on their first screen.
    return { clicked: false, consoleErrors: [], pageErrors: [], rootMounted: true };
  }
  await page.waitForTimeout(INTERACT_SETTLE_MS);
  const interaction: SmokeInteraction = {
    clicked: true,
    consoleErrors: errors.slice(preClickErrorCount),
    pageErrors: pageErrors.slice(preClickPageErrorCount),
    rootMounted: await pageMounted(page),
  };
  if (opts.screenshotPath) {
    try {
      await page.screenshot({ path: opts.screenshotPath, type: "png", fullPage: false });
      interaction.screenshotPath = opts.screenshotPath;
    } catch { /* best-effort — a capture failure never fails the smoke */ }
  }
  return interaction;
}
