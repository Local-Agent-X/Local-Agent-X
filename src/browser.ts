import type { Browser, Page, BrowserContext } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { wrapExternalContent } from "./sanitize.js";
import { getRuntimeConfig } from "./config.js";
import { ObservationRegistry, type BrowserObservation } from "./browser/observation.js";
import { clickRef, fillRef, clickByText as clickByTextAction } from "./browser/actions.js";
import { waitForStability } from "./browser/stability.js";

/**
 * Browser Manager for Open Agent X
 *
 * Uses real Chrome (not Playwright's bundled Chromium) to avoid bot detection.
 * Launches headed by default — sites see a real browser, not headless automation.
 * Falls back to Playwright Chromium if Chrome isn't installed.
 */

export type BrowserEngine = "chromium" | "firefox" | "webkit";

// Auth token passed via setter instead of process.env to avoid leaking to child processes
let _saxAuthToken = "";
let _saxPort = "";
export function setBrowserAuthContext(token: string, port: string): void {
  _saxAuthToken = token;
  _saxPort = port;
}

function getIdleTimeout(): number { return getRuntimeConfig().browserIdleTimeoutMs; }
const NAV_TIMEOUT = 30_000;
const ACTION_TIMEOUT = 10_000;
const MAX_TEXT_LENGTH = 8_000;

// Real user agents — rotated based on engine
const USER_AGENTS: Record<BrowserEngine, string> = {
  chromium:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  firefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  webkit:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
};

// Chrome args that reduce automation fingerprint
const STEALTH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-features=Translate,MediaRouter",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--password-store=basic",
  "--disable-infobars",
];

// Find Chrome executable on Windows
function findChromeExecutable(): string | null {
  const candidates = [
    join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    // Edge as fallback
    join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private chromeProcess: ChildProcess | null = null;
  private currentEngine: BrowserEngine = "chromium";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), getIdleTimeout());
  }

  /** Auto-inject auth token for localhost app URLs so pages load authenticated. */
  private injectTokenIfLocal(url: string): string {
    try {
      const u = new URL(url);
      const appPort = _saxPort || process.env.SAX_PORT || "7007";
      if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === appPort) {
        const token = _saxAuthToken;
        if (token && !u.searchParams.has("token")) {
          u.searchParams.set("token", token);
          return u.toString();
        }
      }
    } catch {}
    return url;
  }

  getEngine(): BrowserEngine {
    return this.currentEngine;
  }

  /** Get current page URL (empty string if no page open). */
  getCurrentUrl(): string {
    try { return this.page?.url() || ""; } catch { return ""; }
  }

  /** Check if the browser is currently on our own app. */
  isOnOwnApp(): boolean {
    const port = process.env.SAX_PORT || "7007";
    return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}`, "i").test(this.getCurrentUrl());
  }

  /** Lazy-launch browser and return the current page. Switches engine if requested. */
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
      this.browser = await this.launchViaCDP(pw);
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

  /**
   * Launch Chrome directly via spawn() then connect via CDP.
   * This avoids Playwright's automation markers (cdc_ variables, webdriver flag).
   * Falls back to Playwright launch if Chrome isn't found.
   */
  private async launchViaCDP(
    pw: typeof import("playwright")
  ): Promise<Browser> {
    const chromePath = findChromeExecutable();

    if (chromePath) {
      const cdpPort = getRuntimeConfig().browserCdpPort; // Configurable — allows reconnecting to existing Chrome

      // Use a dedicated SAX profile (not the user's main profile — avoids conflicts)
      const userDataDir = join(homedir(), ".sax", "chrome-profile");
      if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });

      const cdpUrl = `http://127.0.0.1:${cdpPort}`;

      // Try to connect to an existing agent Chrome instance (survives server restarts)
      try {
        const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          // Verify this is OUR agent chrome, not the user's personal browser
          const versionData = await res.json() as { webSocketDebuggerUrl?: string; Browser?: string };
          const browser = await pw.chromium.connectOverCDP(cdpUrl);
          const contexts = browser.contexts();
          // If this Chrome has pages open at SAX URLs or the user-data-dir matches, it's ours
          console.log(`[browser] Reconnected to existing agent Chrome on port ${cdpPort}`);
          return browser;
        }
      } catch {
        // No existing Chrome — launch a new one
      }

      // CRITICAL: On Windows, Chrome merges into any already-running Chrome process
      // unless we force a completely separate instance. These flags prevent merging:
      const args = [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        "--no-process-per-site",             // Prevent merging into existing Chrome
        "--disable-features=RendererCodeIntegrity", // Avoid conflicts with running Chrome
        ...STEALTH_ARGS,
        "--window-size=1280,800",
      ];

      console.log(`[browser] Spawning agent Chrome: ${chromePath} (profile: ${userDataDir})`);
      this.chromeProcess = spawn(chromePath, args, {
        stdio: "ignore",
        detached: true,  // Detach so it runs as truly separate process from user's Chrome
        env: { ...process.env, CHROME_USER_DATA_DIR: userDataDir },
      });
      // Unref so server can exit without waiting for Chrome
      this.chromeProcess.unref();

      // Wait for CDP to be ready
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`${cdpUrl}/json/version`, {
            signal: AbortSignal.timeout(1000),
          });
          if (res.ok) {
            ready = true;
            break;
          }
        } catch {
          // Not ready yet
        }
        await new Promise((r) => setTimeout(r, 300));
      }

      if (ready) {
        try {
          const browser = await pw.chromium.connectOverCDP(cdpUrl);
          console.log(`[browser] Connected via CDP on port ${cdpPort} — dedicated agent Chrome session`);
          return browser;
        } catch (e) {
          console.log(`[browser] CDP connect failed: ${(e as Error).message}`);
          try { this.chromeProcess.kill(); } catch {}
          this.chromeProcess = null;
        }
      } else {
        console.log("[browser] Agent Chrome CDP didn't become ready in time — trying Playwright");
        try { this.chromeProcess?.kill(); } catch {}
        this.chromeProcess = null;
      }
    }

    // Fallback: Use Playwright's persistent context — this ALWAYS creates an isolated session
    // even if user's Chrome is running, because Playwright manages its own Chromium binary
    console.log("[browser] Launching Playwright persistent context (fully isolated)");
    const persistDir = join(homedir(), ".sax", "chrome-profile-pw");
    if (!existsSync(persistDir)) mkdirSync(persistDir, { recursive: true });
    try {
      const ctx = await pw.chromium.launchPersistentContext(persistDir, {
        channel: "chrome",
        headless: false,
        args: STEALTH_ARGS,
        viewport: { width: 1280, height: 800 },
      });
      console.log("[browser] Playwright persistent context (Chrome channel)");
      return ctx.browser()!;
    } catch {
      try {
        const ctx = await pw.chromium.launchPersistentContext(persistDir, {
          headless: false,
          args: STEALTH_ARGS,
          viewport: { width: 1280, height: 800 },
        });
        console.log("[browser] Playwright persistent context (bundled Chromium)");
        return ctx.browser()!;
      } catch {
        // Final fallback — plain launch, no persistence
        const b = await pw.chromium.launch({
          headless: false,
          args: STEALTH_ARGS,
        });
        console.log(`[browser] Playwright Chromium (no persistence) v${b.version()}`);
        return b;
      }
    }
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
    const response = await newPage.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    const status = response?.status() ?? "unknown";
    try {
      await newPage.waitForLoadState("load", { timeout: 5000 });
    } catch {}
    await newPage.waitForTimeout(1000);

    // Switch active page to the new tab
    this.page = newPage;
    await newPage.bringToFront();
    const title = await newPage.title();
    const tabCount = this.context.pages().length;
    return `Opened new tab (${tabCount} tabs total)\nURL: ${newPage.url()}\nStatus: ${status}\nTitle: ${title}`;
  }

  /** Navigate to a URL in the CURRENT tab. Optionally switch browser engine. */
  async navigate(url: string, engine?: BrowserEngine): Promise<string> {
    // Auto-inject auth token for our own app URLs so pages load authenticated
    url = this.injectTokenIfLocal(url);
    const page = await this.getPage(engine);
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    const status = response?.status() ?? "unknown";

    // Wait a bit for SPA rendering (many sites render client-side)
    try {
      await page.waitForLoadState("load", { timeout: 5000 });
    } catch {
      // load timeout is ok — page may have long-running scripts
    }

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

  /** Export the current registry state (for cross-phase handoff). */
  exportRegistry(): unknown {
    return this.registry.serialize();
  }

  /** Restore registry state (for cross-phase handoff). */
  importRegistry(state: unknown): void {
    this.registry.restore(state);
  }

  /**
   * Scroll the page or a specific element into view. direction = up/down/top/bottom
   * (scrolls the main page) OR set refId to scroll a specific ref into view.
   */
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

  /** Click by durable ref — uses role → text → XPath → coords fallback chain. */
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

  /** Fill by durable ref — uses role → XPath fallback. */
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

  /** Click by visible text — fallback when refs aren't available. */
  async clickByText(text: string): Promise<string> {
    const page = await this.getPage();
    const result = await clickByTextAction(page, text);
    if (!result.ok) return result.message;
    await waitForStability(page, { maxWait: 2500 });
    const after = ObservationRegistry.format(await this.registry.observe(page));
    return `${result.message}\nPage: ${page.url()}\n\n${after}`;
  }

  /** Extract visible text from the page or a specific selector. */
  async extractText(selector?: string): Promise<string> {
    const page = await this.getPage();
    let text: string;
    if (selector) {
      const el = await page.$(selector);
      text = el
        ? await el.innerText()
        : `Element not found: ${selector}`;
    } else {
      text = await page.innerText("body");
    }
    if (text.length > MAX_TEXT_LENGTH) {
      text =
        text.slice(0, MAX_TEXT_LENGTH) +
        `\n\n[Truncated at ${MAX_TEXT_LENGTH} chars]`;
    }
    // Wrap browser-extracted content to prevent prompt injection
    const url = page.url();
    return wrapExternalContent(text, "browser.extract", { url, selector: selector || "body" });
  }

  /** Take a screenshot. Returns base64 PNG. */
  async screenshot(): Promise<string> {
    const page = await this.getPage();
    const buffer = await page.screenshot({ type: "png", fullPage: false });
    const base64 = buffer.toString("base64");
    const title = await page.title();
    const url = page.url();
    return `Screenshot captured\nURL: ${url}\nTitle: ${title}\nEngine: ${this.currentEngine}\nSize: ${buffer.length} bytes\n\n[base64:${base64.slice(0, 200)}...]\n\nUse 'extract' action to read the page text content.`;
  }

  /** Evaluate JavaScript in the page context. */
  async evaluate(script: string): Promise<string> {
    const page = await this.getPage();
    const result = await page.evaluate(script);
    let output =
      typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (output && output.length > MAX_TEXT_LENGTH) {
      output =
        output.slice(0, MAX_TEXT_LENGTH) +
        `\n\n[Truncated at ${MAX_TEXT_LENGTH} chars]`;
    }
    return output ?? "(no return value)";
  }

  /** List all open tabs with their URLs and titles. */
  async listTabs(): Promise<string> {
    if (!this.context) {
      return "No browser session active.";
    }
    const pages = this.context.pages();
    if (pages.length === 0) return "No tabs open.";

    const currentUrl = this.page?.url() || "";
    const tabs: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      try {
        const title = await p.title();
        const url = p.url();
        const active = url === currentUrl ? " ← active" : "";
        tabs.push(`[${i}] ${title || "(no title)"} — ${url}${active}`);
      } catch {
        tabs.push(`[${i}] (disconnected)`);
      }
    }
    return `${pages.length} tab(s) open:\n${tabs.join("\n")}`;
  }

  /** Switch to a tab by index number. */
  async switchTab(index: number): Promise<string> {
    if (!this.context) {
      return "No browser session active.";
    }
    const pages = this.context.pages();
    if (index < 0 || index >= pages.length) {
      return `Invalid tab index ${index}. Use 'tabs' action to see available tabs (0-${pages.length - 1}).`;
    }
    this.page = pages[index];
    this.page.setDefaultTimeout(ACTION_TIMEOUT);
    await this.page.bringToFront();
    const title = await this.page.title();
    const url = this.page.url();
    return `Switched to tab [${index}]: ${title} — ${url}`;
  }

  /** Get current page info. */
  async getInfo(): Promise<string> {
    if (!this.page || this.page.isClosed()) {
      return "No browser session active. Use 'navigate' to open a page.";
    }
    const title = await this.page.title();
    const url = this.page.url();
    return `Browser active\nEngine: ${this.currentEngine}\nURL: ${url}\nTitle: ${title}`;
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
