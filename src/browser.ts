import type { Browser, Page, BrowserContext } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { wrapExternalContent } from "./sanitize.js";

/**
 * Browser Manager for Open Agent X
 *
 * Uses real Chrome (not Playwright's bundled Chromium) to avoid bot detection.
 * Launches headed by default — sites see a real browser, not headless automation.
 * Falls back to Playwright Chromium if Chrome isn't installed.
 */

export type BrowserEngine = "chromium" | "firefox" | "webkit";

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
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
    this.idleTimer = setTimeout(() => this.close(), IDLE_TIMEOUT);
  }

  /** Auto-inject auth token for localhost app URLs so pages load authenticated. */
  private injectTokenIfLocal(url: string): string {
    try {
      const u = new URL(url);
      const appPort = process.env.SAX_PORT || "4800";
      if ((u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.port === appPort) {
        const token = process.env.SAX_AUTH_TOKEN;
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
    const port = process.env.SAX_PORT || "4800";
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
      const cdpPort = 9222 + Math.floor(Math.random() * 1000);

      // Use a dedicated SAX profile (not the user's main profile — avoids conflicts)
      // But copy cookies from the default profile on first run for realistic fingerprint
      const userDataDir = join(homedir(), ".sax", "chrome-profile");
      if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });

      const args = [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        ...STEALTH_ARGS,
        "--window-size=1280,800",
      ];

      console.log(`[browser] Spawning Chrome directly: ${chromePath}`);
      this.chromeProcess = spawn(chromePath, args, {
        stdio: "ignore",
        detached: false,
      });

      // Wait for CDP to be ready
      const cdpUrl = `http://127.0.0.1:${cdpPort}`;
      let ready = false;
      for (let i = 0; i < 20; i++) {
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
          console.log(`[browser] Connected via CDP on port ${cdpPort} — real Chrome, no automation markers`);
          return browser;
        } catch (e) {
          console.log(`[browser] CDP connect failed: ${(e as Error).message}`);
          // Kill the spawned process
          try { this.chromeProcess.kill(); } catch {}
          this.chromeProcess = null;
        }
      } else {
        console.log("[browser] Chrome CDP didn't become ready in time");
        try { this.chromeProcess?.kill(); } catch {}
        this.chromeProcess = null;
      }
    }

    // Fallback: Playwright launch (has automation markers but still works for most sites)
    console.log("[browser] Falling back to Playwright chromium.launch()");
    try {
      const b = await pw.chromium.launch({
        channel: "chrome",
        headless: false,
        args: STEALTH_ARGS,
      });
      console.log(`[browser] Playwright Chrome (headed) v${b.version()}`);
      return b;
    } catch {
      const b = await pw.chromium.launch({
        headless: false,
        args: STEALTH_ARGS,
      });
      console.log(`[browser] Playwright Chromium (headed) v${b.version()}`);
      return b;
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

  // ── Accessibility tree snapshot with numbered refs ──

  private refMap = new Map<number, { role: string; name: string }>();
  private nextRef = 1;

  /**
   * Build an accessibility snapshot of the page — the key to reliable interaction.
   * Returns a tree like:
   *   [1] button "Log in"
   *   [2] textbox "Username"
   *   [3] link "Forgot password?"
   *
   * The agent says "click ref 1" and we resolve it reliably.
   */
  async snapshot(): Promise<string> {
    const page = await this.getPage();
    this.refMap.clear();
    this.nextRef = 1;

    // Build accessibility snapshot by querying interactive elements via JavaScript
    // This runs in the browser context (page.evaluate), not Node
    const elements = await page.evaluate(`(() => {
      const results = [];
      const interactiveTags = {
        BUTTON: "button", A: "link", SELECT: "combobox", TEXTAREA: "textbox",
      };

      const all = document.querySelectorAll(
        'a, button, input, select, textarea, [role="button"], [role="link"], ' +
        '[role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], ' +
        '[role="switch"], [role="option"], [role="treeitem"], [role="combobox"], ' +
        '[role="searchbox"], h1, h2, h3, h4, h5, h6'
      );

      for (const el of all) {
        if (el.offsetParent === null && el.style.position !== 'fixed') continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;

        const tag = el.tagName;
        let role = el.getAttribute('role') || interactiveTags[tag] || "";
        const type = el.type || "";

        if (tag === 'INPUT') {
          if (type === 'submit' || type === 'button') role = 'button';
          else if (type === 'checkbox') role = 'checkbox';
          else if (type === 'radio') role = 'radio';
          else role = 'textbox';
        }
        if (/^H[1-6]$/.test(tag)) role = 'heading';

        let name = el.getAttribute('aria-label')
          || el.placeholder
          || (el.textContent || '').trim().slice(0, 80)
          || (el.value || '').slice(0, 40)
          || el.getAttribute('title')
          || "";

        if (!name && !role) continue;
        name = name.replace(/\\s+/g, ' ').trim();

        results.push({ role, name, tag, type });
      }
      return results;
    })()`) as Array<{ role: string; name: string; tag: string; type: string }>;

    if (elements.length === 0) return "No interactive elements found.";

    const lines: string[] = [];
    for (const el of elements) {
      const ref = this.nextRef++;
      this.refMap.set(ref, { role: el.role, name: el.name });
      // Sanitize element names to prevent prompt injection via malicious websites.
      // Strip newlines, control chars, and escape quotes so attacker-controlled
      // aria-label/textContent can't inject fake refs or LLM instructions.
      const safeName = el.name
        .replace(/[\r\n\t]/g, " ")          // no newlines (blocks instruction injection)
        .replace(/[\x00-\x1f\x7f]/g, "")    // strip control characters
        .replace(/"/g, "'")                  // escape quotes (prevents breaking out of ref format)
        .replace(/\[(\d+)\]/g, "($1)")       // prevent fake ref numbers like [2]
        .slice(0, 80);                       // cap length
      const safeRole = el.role.replace(/[\r\n]/g, "").slice(0, 20);
      const typeStr = el.type ? ` (${el.type.replace(/[\r\n]/g, "").slice(0, 20)})` : "";
      lines.push(`[${ref}] ${safeRole} "${safeName}"${typeStr}`);
    }

    const url = page.url();
    const title = await page.title();
    return `Page: ${title} (${url})\n${lines.length} elements:\n\n${lines.join("\n")}`;
  }

  /** Click an element by ref number (from snapshot). Auto-snapshots after click. */
  async clickByRef(ref: number): Promise<string> {
    const page = await this.getPage();
    const info = this.refMap.get(ref);
    if (!info) {
      return `Ref [${ref}] not found. Use 'snapshot' action first to get current refs.`;
    }

    // Resolve via getByRole (most reliable cross-DOM method)
    const locator = page.getByRole(info.role as any, { name: info.name, exact: false });
    const count = await locator.count();

    if (count === 0) {
      // Fallback: find by text content
      const textLocator = page.getByText(info.name, { exact: false });
      if ((await textLocator.count()) > 0) {
        await textLocator.first().click({ timeout: ACTION_TIMEOUT });
        await page.waitForTimeout(1000);
        // Auto-snapshot so agent sees what changed
        const snap = await this.snapshot();
        return `Clicked "${info.name}" (found by text).\nPage: ${page.url()}\n\n${snap}`;
      }
      return `Could not find element [${ref}] ${info.role} "${info.name}" on the page. Page may have changed — take a new snapshot.`;
    }

    await locator.first().click({ timeout: ACTION_TIMEOUT });
    await page.waitForTimeout(1000);
    // Auto-snapshot so agent sees what changed after click
    const snap = await this.snapshot();
    return `Clicked [${ref}] ${info.role} "${info.name}"\nPage: ${page.url()}\n\n${snap}`;
  }

  /** Fill an element by ref number. */
  async fillByRef(ref: number, value: string): Promise<string> {
    const page = await this.getPage();
    const info = this.refMap.get(ref);
    if (!info) {
      return `Ref [${ref}] not found. Use 'snapshot' action first to get current refs.`;
    }

    const locator = page.getByRole(info.role as any, { name: info.name, exact: false });
    if ((await locator.count()) === 0) {
      return `Could not find element [${ref}] ${info.role} "${info.name}". Take a new snapshot.`;
    }

    await locator.first().fill(value, { timeout: ACTION_TIMEOUT });
    return `Filled [${ref}] ${info.role} "${info.name}" with value (${value.length} chars)`;
  }

  /** Click by visible text content (fallback when refs aren't available). Auto-snapshots after. */
  async clickByText(text: string): Promise<string> {
    const page = await this.getPage();
    const locator = page.getByText(text, { exact: false });
    const count = await locator.count();
    if (count === 0) {
      // Try getByRole with the text as name
      for (const role of ["button", "link", "menuitem", "tab"]) {
        const roleLocator = page.getByRole(role as any, { name: text, exact: false });
        if ((await roleLocator.count()) > 0) {
          await roleLocator.first().click({ timeout: ACTION_TIMEOUT });
          await page.waitForTimeout(1000);
          const snap = await this.snapshot();
          return `Clicked ${role} "${text}"\nPage: ${page.url()}\n\n${snap}`;
        }
      }
      return `No element with text "${text}" found on the page.`;
    }
    await locator.first().click({ timeout: ACTION_TIMEOUT });
    await page.waitForTimeout(1000);
    const snap = await this.snapshot();
    return `Clicked text "${text}"\nPage: ${page.url()}\n\n${snap}`;
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

// Per-session browser instances — keyed by session ID, no global mutable state
const instances = new Map<string, BrowserManager>();

/**
 * Get browser manager for a specific session. Thread-safe — no global state.
 * Each caller passes the session ID explicitly to avoid race conditions.
 */
export function getBrowserManager(sessionId: string = "default"): BrowserManager {
  let instance = instances.get(sessionId);
  if (!instance) {
    instance = new BrowserManager();
    instances.set(sessionId, instance);
  }
  return instance;
}

export async function closeBrowser(sessionId: string = "default"): Promise<void> {
  const instance = instances.get(sessionId);
  if (instance) {
    await instance.close();
    instances.delete(sessionId);
  }
}

export async function closeAllBrowsers(): Promise<void> {
  for (const [id, instance] of instances) {
    await instance.close();
    instances.delete(id);
  }
}

// Backwards compat — no-op, session ID now passed directly
export function setCurrentBrowserSession(_sessionId: string): void {
  // Deprecated: session ID is now passed directly to getBrowserManager/closeBrowser
}
