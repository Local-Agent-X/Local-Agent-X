import type { Browser, Page } from "playwright";

/**
 * Manages a persistent browser instance with support for Chromium, Firefox, and WebKit.
 * Lazy-initialized on first use, reused across tool calls within a session.
 * Auto-closes after 10 minutes of inactivity.
 * If the agent requests a different engine, the current browser is closed and a new one launches.
 */

export type BrowserEngine = "chromium" | "firefox" | "webkit";

const IDLE_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const NAV_TIMEOUT = 30_000;
const ACTION_TIMEOUT = 10_000;
const MAX_TEXT_LENGTH = 8_000;

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private currentEngine: BrowserEngine = "chromium";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_TIMEOUT);
  }

  /** Get the currently active engine name. */
  getEngine(): BrowserEngine {
    return this.currentEngine;
  }

  /** Lazy-launch browser and return the current page. Switches engine if requested. */
  async getPage(engine?: BrowserEngine): Promise<Page> {
    // If a different engine is requested, close current and relaunch
    if (engine && engine !== this.currentEngine && this.browser) {
      await this.close();
    }
    if (engine) this.currentEngine = engine;

    if (this.page && !this.page.isClosed()) {
      this.resetIdle();
      return this.page;
    }

    // Dynamic import so Playwright is only loaded when actually used
    const pw = await import("playwright");
    const launcher = pw[this.currentEngine];
    this.browser = await launcher.launch({ headless: true });
    const context = await this.browser.newContext({
      userAgent: `SecretAgentX/0.1 (Playwright/${this.currentEngine})`,
      viewport: { width: 1280, height: 800 },
    });
    this.page = await context.newPage();
    this.page.setDefaultTimeout(ACTION_TIMEOUT);
    this.resetIdle();
    return this.page;
  }

  /** Navigate to a URL. Optionally switch browser engine. Returns page title + text summary. */
  async navigate(url: string, engine?: BrowserEngine): Promise<string> {
    const page = await this.getPage(engine);
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    const status = response?.status() ?? "unknown";
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
    const selected = await page.selectOption(selector, value, { timeout: ACTION_TIMEOUT });
    return `Selected "${selected.join(", ")}" in ${selector}`;
  }

  /** Extract visible text from the page or a specific selector. */
  async extractText(selector?: string): Promise<string> {
    const page = await this.getPage();
    let text: string;
    if (selector) {
      const el = await page.$(selector);
      text = el ? (await el.innerText()) : `Element not found: ${selector}`;
    } else {
      text = await page.innerText("body");
    }
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + `\n\n[Truncated at ${MAX_TEXT_LENGTH} chars]`;
    }
    return text;
  }

  /** Take a screenshot. Returns base64 PNG with context info. */
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
    let output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    if (output && output.length > MAX_TEXT_LENGTH) {
      output = output.slice(0, MAX_TEXT_LENGTH) + `\n\n[Truncated at ${MAX_TEXT_LENGTH} chars]`;
    }
    return output ?? "(no return value)";
  }

  /** Get current page info without performing an action. */
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
      this.page = null;
    }
  }

  isActive(): boolean {
    return this.browser !== null && this.page !== null && !this.page.isClosed();
  }
}

// Singleton instance shared across tool calls
let instance: BrowserManager | null = null;

export function getBrowserManager(): BrowserManager {
  if (!instance) {
    instance = new BrowserManager();
  }
  return instance;
}

export async function closeBrowser(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}
