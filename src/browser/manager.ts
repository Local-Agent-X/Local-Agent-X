import type { Page, BrowserContext } from "playwright";
import { ObservationRegistry, type BrowserObservation } from "./observation.js";
import { clickRef, fillRef, clickByText as clickByTextAction } from "./actions.js";
import { waitForStability } from "./stability.js";
import { installDialogHandler, handleNextDialog } from "./dialog-handler.js";
import { ACTION_TIMEOUT, NAV_TIMEOUT, type BrowserEngine } from "./launcher.js";
import { acquireSessionContext } from "./runtime.js";
import { installDownloadHandler } from "./downloads.js";
import { injectTokenIfLocal } from "./auth-context.js";
import { safeHost, redirectMessage } from "./redirect.js";
import { getRuntimeConfig } from "../config.js";
import {
  extractTextFrom, screenshotAsBase64, evaluateScript,
  listTabs as listTabsOp, resolveSwitchTab, pageInfo,
} from "./page-ops.js";

function isBlankish(url: string): boolean {
  return url === "" || url === "about:blank" || url.startsWith("chrome://newtab");
}

/**
 * Per-session browser surface. Each session owns its own tabs + observation
 * registry inside the shared Chrome (see runtime.ts), so a mission navigating
 * mid-task can't move the tab or reassign the refs another session is using.
 * The Chrome process and connection are NOT owned here — close() only tears
 * down this session's tabs (and its own context in isolated mode).
 */
export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private owned: Page[] = [];
  private currentEngine: BrowserEngine = "chromium";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private registry = new ObservationRegistry();
  private onIdle: (() => void) | null = null;
  private peerPages: (() => Page[]) | null = null;

  constructor(
    private readonly sessionId: string = "default",
    private readonly isolated: boolean = false,
  ) {}

  /** Called when the idle timer fires after this session is torn down. */
  setIdleHandler(fn: () => void): void { this.onIdle = fn; }
  /** Supplies tabs owned by other sessions so we never adopt one of theirs. */
  setPeerPages(fn: () => Page[]): void { this.peerPages = fn; }
  listOwnedPages(): Page[] { return this.owned.filter((p) => !p.isClosed()); }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = getRuntimeConfig().browserIdleTimeoutMs;
    this.idleTimer = setTimeout(() => {
      void this.close().then(() => { try { this.onIdle?.(); } catch { /* ignore */ } });
    }, ms);
    this.idleTimer.unref?.();
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
    const port = process.env.LAX_PORT ?? "7007";
    return new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}`, "i").test(this.getCurrentUrl());
  }

  /** Adopt an unclaimed blank tab (consuming Chrome's initial about:blank so
   *  stray tabs don't pile up) or open a fresh one for this session. */
  private async acquirePage(): Promise<Page> {
    const ctx = this.context!;
    const peers = this.peerPages ? this.peerPages() : [];
    const adoptable = ctx.pages().find(
      (p) => !p.isClosed() && !peers.includes(p) && !this.owned.includes(p) && isBlankish(p.url()),
    );
    const page = adoptable ?? (await ctx.newPage());
    if (!this.owned.includes(page)) this.owned.push(page);
    return this.adoptPage(page);
  }

  async getPage(engine?: BrowserEngine): Promise<Page> {
    if (engine && engine !== this.currentEngine && this.context) {
      await this.close();
    }
    if (engine) this.currentEngine = engine;

    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.title();
        this.armIdle();
        return this.page;
      } catch {
        this.page = null;
        this.context = null;
      }
    }

    this.context = await acquireSessionContext(this.currentEngine, this.isolated);
    this.page = await this.acquirePage();
    this.armIdle();
    return this.page;
  }

  async newTab(url: string): Promise<string> {
    url = injectTokenIfLocal(url);
    await this.getPage();
    const requestedHost = safeHost(url);
    const newPage = this.adoptPage(await this.context!.newPage());
    this.owned.push(newPage);
    const response = await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const status = response?.status() ?? "unknown";
    try { await newPage.waitForLoadState("load", { timeout: 5000 }); } catch { /* load timeout ok */ }
    await newPage.waitForTimeout(1000);
    this.page = newPage;
    await newPage.bringToFront();
    const title = await newPage.title();
    const tabCount = this.listOwnedPages().length;
    const redirect = redirectMessage(requestedHost, safeHost(newPage.url()));
    return `Opened new tab (${tabCount} tabs total)\nURL: ${newPage.url()}\nStatus: ${status}\nTitle: ${title}${redirect}`;
  }

  async navigate(url: string, engine?: BrowserEngine): Promise<string> {
    url = injectTokenIfLocal(url);
    const requestedHost = safeHost(url);
    const page = await this.getPage(engine);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    const status = response?.status() ?? "unknown";
    // HTTP error responses (404, 500, etc.) are NOT a successful navigation
    // outcome — silently returning "Status: 404" as ok let agents treat broken
    // pages as live. Surface via thrown Error so the outer handler converts to err().
    if (typeof status === "number" && status >= 400) {
      throw new Error(`Navigation failed: HTTP ${status} (${page.url()})`);
    }
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
    // Best-effort readback: confirm the value actually landed. Masked inputs
    // (type=password) return "" from inputValue() — skip verification rather
    // than fail. If the readback itself throws (element gone, navigation,
    // detach) we don't bury the underlying successful fill.
    try {
      const loc = page.locator(selector);
      const actual = await loc.inputValue();
      if (actual === value) {
        return `Filled "${selector}" with value (${value.length} chars)`;
      }
      if (actual === "") {
        const type = (await loc.getAttribute("type") || "").toLowerCase();
        if (type === "password") {
          return `Filled "${selector}" (verification skipped: masked input)`;
        }
      }
      throw new Error(`Fill did not land: expected '${value}' got '${actual}'`);
    } catch (e) {
      // Re-throw the mismatch error — only swallow readback-machinery failures.
      if ((e as Error).message?.startsWith("Fill did not land:")) throw e;
      return `Filled "${selector}" (verification skipped: readback failed)`;
    }
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
    return listTabsOp(this.listOwnedPages(), this.page);
  }

  async switchTab(index: number): Promise<string> {
    const result = await resolveSwitchTab(this.listOwnedPages(), index);
    if (result.ok && result.page) {
      this.page = this.adoptPage(result.page);
    }
    return result.message;
  }

  async getInfo(): Promise<string> {
    return pageInfo(this.page, this.currentEngine);
  }

  /** Tear down only this session's tabs + refs. The shared Chrome stays up;
   *  in isolated mode the session's own context is closed too. */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.registry.reset();
    for (const p of this.owned) {
      try { if (!p.isClosed()) await p.close(); } catch { /* already closed */ }
    }
    this.owned = [];
    if (this.isolated && this.context) {
      try { await this.context.close(); } catch { /* already closed */ }
    }
    this.context = null;
    this.page = null;
  }

  isActive(): boolean {
    return this.page !== null && !this.page.isClosed();
  }
}
