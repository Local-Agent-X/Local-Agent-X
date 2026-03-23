import type { Browser, Page, BrowserContext } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Browser Manager for Secret Agent X
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
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-features=Translate,MediaRouter",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--password-store=basic",
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

  getEngine(): BrowserEngine {
    return this.currentEngine;
  }

  /** Lazy-launch browser and return the current page. Switches engine if requested. */
  async getPage(engine?: BrowserEngine): Promise<Page> {
    if (engine && engine !== this.currentEngine && this.browser) {
      await this.close();
    }
    if (engine) this.currentEngine = engine;

    if (this.page && !this.page.isClosed()) {
      this.resetIdle();
      return this.page;
    }

    const pw = await import("playwright");

    if (this.currentEngine === "chromium") {
      // Strategy: spawn Chrome directly (no Playwright automation markers)
      // then connect via CDP — this is what upstream does
      this.browser = await this.launchViaCDP(pw);
    } else {
      const launcher = pw[this.currentEngine];
      this.browser = await launcher.launch({
        headless: false,
        args: STEALTH_ARGS,
      });
    }

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
        "--disable-web-security",
        "--disable-features=IsolateOrigins,site-per-process",
        "about:blank",
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

  /** Navigate to a URL. Optionally switch browser engine. */
  async navigate(url: string, engine?: BrowserEngine): Promise<string> {
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
    const text = await this.extractText();
    return `Navigated to: ${page.url()}\nStatus: ${status}\nTitle: ${title}\nEngine: ${this.currentEngine}\n\n${text}`;
  }

  /** Click an element by CSS selector. */
  async click(selector: string): Promise<string> {
    const page = await this.getPage();
    await page.click(selector, { timeout: ACTION_TIMEOUT });
    await page.waitForTimeout(500);
    const title = await page.title();
    return `Clicked: ${selector}\nPage: ${page.url()}\nTitle: ${title}`;
  }

  /** Fill a text input by CSS selector. */
  async fill(selector: string, value: string): Promise<string> {
    const page = await this.getPage();
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
    return text;
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

// Per-session browser instances
const instances = new Map<string, BrowserManager>();
let currentSessionId = "default";

export function setCurrentBrowserSession(sessionId: string): void {
  currentSessionId = sessionId;
}

export function getBrowserManager(): BrowserManager {
  let instance = instances.get(currentSessionId);
  if (!instance) {
    instance = new BrowserManager();
    instances.set(currentSessionId, instance);
  }
  return instance;
}

export async function closeBrowser(): Promise<void> {
  const instance = instances.get(currentSessionId);
  if (instance) {
    await instance.close();
    instances.delete(currentSessionId);
  }
}

export async function closeAllBrowsers(): Promise<void> {
  for (const [id, instance] of instances) {
    await instance.close();
    instances.delete(id);
  }
}
