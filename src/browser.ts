import type { Browser, Page, BrowserContext } from "playwright";
import type { ChildProcess } from "node:child_process";
import { wrapExternalContent } from "./sanitize.js";
import { ObservationRegistry, type BrowserObservation } from "./browser/observation.js";
import { clickRef, fillRef, clickByText as clickByTextAction } from "./browser/actions.js";
import { waitForStability } from "./browser/stability.js";
import {
  launchViaCDP, USER_AGENTS, STEALTH_ARGS,
  NAV_TIMEOUT, ACTION_TIMEOUT,
  type BrowserEngine,
} from "./browser/launcher.js";
import {
  extractTextFrom, screenshotAsBase64, evaluateScript,
  listTabs as listTabsOp, resolveSwitchTab, pageInfo,
} from "./browser/page-ops.js";

/**
 * Browser Manager for Open Agent X.
 *
 * Uses real Chrome (via CDP) to avoid bot detection. Launcher + constants
 * live in ./browser/launcher.ts; this file focuses on session state, page
 * operations, and observation/action orchestration.
 */

export type { BrowserEngine };

// Auth token passed via setter instead of process.env to avoid leaking to child processes
let _saxAuthToken = "";
let _saxPort = "";
export function setBrowserAuthContext(token: string, port: string): void {
  _saxAuthToken = token;
  _saxPort = port;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private chromeProcess: ChildProcess | null = null;
  private currentEngine: BrowserEngine = "chromium";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private resetIdle(): void {
    // Idle auto-close disabled — browser stays open until explicitly closed.
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // Auto-inject auth token for localhost app URLs so pages load authenticated.
  private injectTokenIfLocal(url: string): string {
    try {
      const u = new URL(url);
      const appPort = _saxPort || process.env.LAX_PORT || process.env.SAX_PORT || "7007";
      if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === appPort) {
        if (_saxAuthToken && !u.searchParams.has("token")) {
          u.searchParams.set("token", _saxAuthToken);
          return u.toString();
        }
      }
    } catch { /* invalid URL — caller handles */ }
    return url;
  }

  getEngine(): BrowserEngine { return this.currentEngine; }
  getCurrentUrl(): string { try { return this.page?.url() || ""; } catch { return ""; } }
  isOnOwnApp(): boolean {
    const port = process.env.LAX_PORT ?? process.env.SAX_PORT ?? "7007";
    return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}`, "i").test(this.getCurrentUrl());
  }

  async getPage(engine?: BrowserEngine): Promise<Page> {
    if (engine && engine !== this.currentEngine && this.browser) {
      await this.close();
    }
    if (engine) this.currentEngine = engine;

    // Reuse existing page if still alive
    if (this.page) {
      try {
        // Quick check if page is still connected
        await this.page.title();
        this.resetIdle();
        return this.page;
      } catch {
        // Page disconnected — need to relaunch
        this.page = null;
        this.context = null;
        this.browser = null;
      }
    }

    const pw = await import("playwright");

    if (this.currentEngine === "chromium") {
      const { browser, chromeProcess } = await launchViaCDP(pw);
      this.browser = browser;
      this.chromeProcess = chromeProcess;
    } else {
      const launcher = pw[this.currentEngine];
      this.browser = await launcher.launch({
        headless: false,
        args: STEALTH_ARGS,
      });
    }

    // For CDP-connected browsers, reuse the existing context/page from Chrome
    // instead of creating new ones (which opens extra about:blank tabs)
    const existingContexts = this.browser.contexts();
    if (existingContexts.length > 0) {
      this.context = existingContexts[0];
      const existingPages = this.context.pages();
      if (existingPages.length > 0) {
        this.page = existingPages[0];
        this.page.setDefaultTimeout(ACTION_TIMEOUT);
        this.resetIdle();
        return this.page;
      }
    }

    // Fallback: create new context (non-CDP path)
    this.context = await this.browser.newContext({
      userAgent: USER_AGENTS[this.currentEngine],
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "America/Chicago",
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(ACTION_TIMEOUT);
    this.resetIdle();
    return this.page;
  }

  /** Open a URL in a NEW tab (keeps existing tabs). */
  async newTab(url: string): Promise<string> {
    url = this.injectTokenIfLocal(url);
    if (!this.context) {
      // No browser yet — just navigate normally
      return this.navigate(url);
    }
    const newPage = await this.context.newPage();
    newPage.setDefaultTimeout(ACTION_TIMEOUT);
    const response = await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const status = response?.status() ?? "unknown";
    try { await newPage.waitForLoadState("load", { timeout: 5000 }); } catch { /* load timeout ok */ }
    await newPage.waitForTimeout(1000);
    this.page = newPage;
    await newPage.bringToFront();
    const title = await newPage.title();
    const tabCount = this.context.pages().length;
    return `Opened new tab (${tabCount} tabs total)\nURL: ${newPage.url()}\nStatus: ${status}\nTitle: ${title}`;
  }

  async navigate(url: string, engine?: BrowserEngine): Promise<string> {
    url = this.injectTokenIfLocal(url);
    const page = await this.getPage(engine);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const status = response?.status() ?? "unknown";
    try { await page.waitForLoadState("load", { timeout: 5000 }); } catch { /* load timeout ok */ }

    // Give JS frameworks a moment to hydrate
    await page.waitForTimeout(1000);

    const title = await page.title();
    // Auto-snapshot so agent sees interactive elements immediately
    const snap = await this.snapshot();
    return `Navigated to: ${page.url()}\nStatus: ${status}\nTitle: ${title}\n\n${snap}`;
  }

  /** Click an element by CSS selector. Auto-snapshots after. */
  async click(selector: string): Promise<string> {
    const page = await this.getPage();
    await page.waitForSelector(selector, { state: "visible", timeout: 5000 });
    await page.click(selector, { timeout: ACTION_TIMEOUT });
    await page.waitForTimeout(1000);
    const snap = await this.snapshot();
    return `Clicked: ${selector}\nPage: ${page.url()}\n\n${snap}`;
  }

  /** Fill a text input by CSS selector. */
  async fill(selector: string, value: string): Promise<string> {
    const page = await this.getPage();
    // Wait for element but with shorter timeout — auto-recovery in browser-tools handles fallbacks
    await page.waitForSelector(selector, { state: "visible", timeout: 5000 });
    await page.fill(selector, value, { timeout: ACTION_TIMEOUT });
    return `Filled "${selector}" with value (${value.length} chars)`;
  }

  /** Select an option from a dropdown. */
  async select(selector: string, value: string): Promise<string> {
    const page = await this.getPage();
    const selected = await page.selectOption(selector, value, {
      timeout: ACTION_TIMEOUT,
    });
    return `Selected "${selected.join(", ")}" in ${selector}`;
  }

  // ── Durable-ref observation (ObservationRegistry-backed) ──

  private registry = new ObservationRegistry();

  /** Run a structured observation — returns the raw diff object. */
  async observe(): Promise<BrowserObservation> {
    const page = await this.getPage();
    return this.registry.observe(page);
  }

  /**
   * Formatted observation for LLM consumption. On the first call after a
   * navigation the full list is emitted; subsequent calls emit a diff
   * (+ added / - removed / ~ changed) and a viewport-only default listing.
   */
  async snapshot(): Promise<string> {
    const page = await this.getPage();
    const obs = await this.registry.observe(page);
    return ObservationRegistry.format(obs);
  }

  exportRegistry(): unknown { return this.registry.serialize(); }
  importRegistry(state: unknown): void { this.registry.restore(state); }

  async scroll(opts: { direction?: "up" | "down" | "top" | "bottom"; refId?: number; amount?: number }): Promise<string> {
    const page = await this.getPage();
    if (opts.refId !== undefined) {
      const ref = this.registry.get(opts.refId);
      if (!ref) return `Ref [${opts.refId}] not found — re-observe first`;
      try {
        const loc = page.locator(`xpath=${ref.xpath}`);
        await loc.first().scrollIntoViewIfNeeded({ timeout: 3000 });
        await waitForStability(page, { maxWait: 1500 });
        return `Scrolled ref [${opts.refId}] into view`;
      } catch (e) {
        return `Could not scroll ref [${opts.refId}]: ${(e as Error).message}`;
      }
    }
    const amount = opts.amount ?? 600;
    const dir = opts.direction ?? "down";
    if (dir === "top") {
      await page.evaluate("window.scrollTo(0, 0)");
    } else if (dir === "bottom") {
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    } else {
      const delta = dir === "up" ? -amount : amount;
      await page.evaluate(`window.scrollBy(0, ${delta})`);
    }
    await waitForStability(page, { maxWait: 1500 });
    return `Scrolled ${dir}${opts.refId ? "" : ` (${amount}px)`}`;
  }

  async clickByRef(ref: number): Promise<string> {
    const page = await this.getPage();
    let result = await clickRef(page, this.registry, ref);
    if (!result.ok) {
      // Stale ref — re-observe then retry once.
      await this.registry.observe(page);
      result = await clickRef(page, this.registry, ref);
    }
    if (!result.ok) {
      const refreshed = ObservationRegistry.format(await this.registry.observe(page));
      return `${result.message}\n\nCurrent page:\n\n${refreshed}`;
    }
    await waitForStability(page, { maxWait: 2500 });
    const after = ObservationRegistry.format(await this.registry.observe(page));
    return `${result.message}\nPage: ${page.url()}\n\n${after}`;
  }

  async fillByRef(ref: number, value: string): Promise<string> {
    const page = await this.getPage();
    let result = await fillRef(page, this.registry, ref, value);
    if (!result.ok) {
      await this.registry.observe(page);
      result = await fillRef(page, this.registry, ref, value);
    }
    if (!result.ok) {
      const refreshed = ObservationRegistry.format(await this.registry.observe(page));
      return `${result.message}\n\nCurrent page:\n\n${refreshed}`;
    }
    return `${result.message} — ${value.length} chars`;
  }

  async clickByText(text: string): Promise<string> {
    const page = await this.getPage();
    const result = await clickByTextAction(page, text);
    if (!result.ok) return result.message;
    await waitForStability(page, { maxWait: 2500 });
    const after = ObservationRegistry.format(await this.registry.observe(page));
    return `${result.message}\nPage: ${page.url()}\n\n${after}`;
  }

  async extractText(selector?: string): Promise<string> {
    return extractTextFrom(await this.getPage(), selector);
  }

  async screenshot(): Promise<string> {
    return screenshotAsBase64(await this.getPage(), this.currentEngine);
  }

  async evaluate(script: string): Promise<string> {
    return evaluateScript(await this.getPage(), script);
  }

  async listTabs(): Promise<string> {
    return listTabsOp(this.context, this.page);
  }

  async switchTab(index: number): Promise<string> {
    const result = await resolveSwitchTab(this.context, index);
    if (result.ok && result.page) {
      this.page = result.page;
      this.page.setDefaultTimeout(ACTION_TIMEOUT);
    }
    return result.message;
  }

  async getInfo(): Promise<string> {
    return pageInfo(this.page, this.currentEngine);
  }

  /** Close the browser and clean up. */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.registry.reset();
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // Already closed
      }
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    // Kill spawned Chrome process if we launched one directly
    if (this.chromeProcess) {
      try {
        this.chromeProcess.kill();
      } catch {}
      this.chromeProcess = null;
    }
  }

  isActive(): boolean {
    return (
      this.browser !== null && this.page !== null && !this.page.isClosed()
    );
  }
}

// Shared browser instance — Chrome can only open one user-data-dir at a time,
// so all sessions/agents share a single browser with separate tabs.
let sharedInstance: BrowserManager | null = null;

// Per-process browser mutex. The shared instance plus the observation-ref
// registry can race when two sessions enqueue browser actions concurrently
// (e.g. session A clicks ref 3 mid-navigate while session B's snapshot
// reassigns refs). We serialize every tool entry through a promise chain.
let browserChain: Promise<unknown> = Promise.resolve();
let currentOwnerSessionId: string | null = null;

import { createLogger as createBrowserLogger } from "./logger.js";
const browserMutexLog = createBrowserLogger("browser.mutex");

export function withBrowserLock<T>(sessionId: string, fn: () => Promise<T>, onQueued?: () => void): Promise<T> {
  const queued = currentOwnerSessionId !== null && currentOwnerSessionId !== sessionId;
  if (queued && onQueued) {
    try { onQueued(); } catch {}
  }
  const next = browserChain.then(async () => {
    const prevOwner = currentOwnerSessionId;
    if (prevOwner !== null && prevOwner !== sessionId) {
      browserMutexLog.info(`[browser-mutex] handover ${prevOwner} -> ${sessionId}`);
    }
    currentOwnerSessionId = sessionId;
    try {
      return await fn();
    } finally {
      if (currentOwnerSessionId === sessionId) currentOwnerSessionId = null;
    }
  });
  // Catch chain errors so a single tool failure doesn't poison every later
  // browser action with the same rejection.
  browserChain = next.catch(() => {});
  return next;
}

export function getCurrentBrowserOwnerSessionId(): string | null {
  return currentOwnerSessionId;
}

/**
 * Get browser manager. All sessions share a single Chrome instance to avoid
 * conflicts from multiple processes trying to lock the same user-data-dir.
 * Each agent/session uses separate tabs within the shared browser.
 */
export function getBrowserManager(_sessionId: string = "default"): BrowserManager {
  if (!sharedInstance) {
    sharedInstance = new BrowserManager();
  }
  return sharedInstance;
}

export async function closeBrowser(_sessionId: string = "default"): Promise<void> {
  if (sharedInstance) {
    await sharedInstance.close();
    sharedInstance = null;
  }
}

export async function closeAllBrowsers(): Promise<void> {
  if (sharedInstance) {
    await sharedInstance.close();
    sharedInstance = null;
  }
}

// Backwards compat — no-op, session ID now passed directly
export function setCurrentBrowserSession(_sessionId: string): void {
  // Deprecated: session ID is now passed directly to getBrowserManager/closeBrowser
}
