import type { Browser, Page, BrowserContext } from "playwright";
import type { ChildProcess } from "node:child_process";
import { ObservationRegistry, type BrowserObservation } from "./observation.js";
import { clickRef, fillRef, clickByText as clickByTextAction } from "./actions.js";
import { waitForStability } from "./stability.js";
import { installDialogHandler, handleNextDialog } from "./dialog-handler.js";
import {
  launchViaCDP, USER_AGENTS, STEALTH_ARGS,
  NAV_TIMEOUT, ACTION_TIMEOUT,
  type BrowserEngine,
} from "./launcher.js";
import { installDownloadHandler } from "./downloads.js";
import { injectTokenIfLocal } from "./auth-context.js";
import { safeHost, redirectMessage } from "./redirect.js";
import {
  extractTextFrom, screenshotAsBase64, evaluateScript,
  listTabs as listTabsOp, resolveSwitchTab, pageInfo,
} from "./page-ops.js";

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private chromeProcess: ChildProcess | null = null;
  private currentEngine: BrowserEngine = "chromium";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private registry = new ObservationRegistry();

  private resetIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private adoptPage(p: Page): Page {
    p.setDefaultTimeout(ACTION_TIMEOUT);
    installDialogHandler(p);
    installDownloadHandler(p);
    return p;
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

    if (this.page) {
      try {
        await this.page.title();
        this.resetIdle();
        return this.page;
      } catch {
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
    // instead of creating new ones (which opens extra about:blank tabs).
    const existingContexts = this.browser.contexts();
    if (existingContexts.length > 0) {
      this.context = existingContexts[0];
      const existingPages = this.context.pages();
      if (existingPages.length > 0) {
        this.page = this.adoptPage(existingPages[0]);
        this.resetIdle();
        return this.page;
      }
    }

    this.context = await this.browser.newContext({
      userAgent: USER_AGENTS[this.currentEngine],
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      timezoneId: "America/Chicago",
    });

    this.page = this.adoptPage(await this.context.newPage());
    this.resetIdle();
    return this.page;
  }

  async newTab(url: string): Promise<string> {
    url = injectTokenIfLocal(url);
    if (!this.context) return this.navigate(url);
    const requestedHost = safeHost(url);
    const newPage = this.adoptPage(await this.context.newPage());
    const response = await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const status = response?.status() ?? "unknown";
    try { await newPage.waitForLoadState("load", { timeout: 5000 }); } catch { /* load timeout ok */ }
    await newPage.waitForTimeout(1000);
    this.page = newPage;
    await newPage.bringToFront();
    const title = await newPage.title();
    const tabCount = this.context.pages().length;
    const redirect = redirectMessage(requestedHost, safeHost(newPage.url()));
    return `Opened new tab (${tabCount} tabs total)\nURL: ${newPage.url()}\nStatus: ${status}\nTitle: ${title}${redirect}`;
  }

  async navigate(url: string, engine?: BrowserEngine): Promise<string> {
    url = injectTokenIfLocal(url);
    const requestedHost = safeHost(url);
    const page = await this.getPage(engine);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const status = response?.status() ?? "unknown";
    try { await page.waitForLoadState("load", { timeout: 5000 }); } catch { /* load timeout ok */ }
    await page.waitForTimeout(1000);

    const title = await page.title();
    const redirect = redirectMessage(requestedHost, safeHost(page.url()));
    const snap = await this.snapshot();
    return `Navigated to: ${page.url()}\nStatus: ${status}\nTitle: ${title}${redirect}\n\n${snap}`;
  }

  async click(selector: string): Promise<string> {
    const page = await this.getPage();
    await page.waitForSelector(selector, { state: "visible", timeout: 5000 });
    await page.click(selector, { timeout: ACTION_TIMEOUT });
    await page.waitForTimeout(1000);
    const snap = await this.snapshot();
    return `Clicked: ${selector}\nPage: ${page.url()}\n\n${snap}`;
  }

  async fill(selector: string, value: string): Promise<string> {
    const page = await this.getPage();
    await page.waitForSelector(selector, { state: "visible", timeout: 5000 });
    await page.fill(selector, value, { timeout: ACTION_TIMEOUT });
    return `Filled "${selector}" with value (${value.length} chars)`;
  }

  async select(selector: string, value: string): Promise<string> {
    const page = await this.getPage();
    const selected = await page.selectOption(selector, value, { timeout: ACTION_TIMEOUT });
    return `Selected "${selected.join(", ")}" in ${selector}`;
  }

  async observe(): Promise<BrowserObservation> {
    const page = await this.getPage();
    return this.registry.observe(page);
  }

  // Obstructions and native dialogs are surfaced at the TOP. First call after
  // navigation emits the full ref list; subsequent calls emit a diff
  // (+ added / - removed / ~ changed).
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

  async dialogAccept(promptText?: string): Promise<string> {
    const page = await this.getPage();
    return handleNextDialog(page, "accept", promptText);
  }

  async dialogDismiss(): Promise<string> {
    const page = await this.getPage();
    return handleNextDialog(page, "dismiss");
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
      this.page = this.adoptPage(result.page);
    }
    return result.message;
  }

  async getInfo(): Promise<string> {
    return pageInfo(this.page, this.currentEngine);
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.registry.reset();
    if (this.browser) {
      try { await this.browser.close(); } catch { /* already closed */ }
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    if (this.chromeProcess) {
      try { this.chromeProcess.kill(); } catch {}
      this.chromeProcess = null;
    }
  }

  isActive(): boolean {
    return this.browser !== null && this.page !== null && !this.page.isClosed();
  }
}
