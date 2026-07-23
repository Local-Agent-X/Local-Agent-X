import type { Page, BrowserContext, Response } from "playwright";
import { ObservationRegistry, type BrowserObservation } from "./observation.js";
import { fingerprintPage, scrollPage, clickRefOn, fillRefOn, clickTextOn } from "./interactions.js";
import { installDialogHandler, handleNextDialog } from "./dialog-handler.js";
import { installRequestGuard } from "./guards.js";
import { wirePopupAdoption } from "./manager-popups.js";
import { ACTION_TIMEOUT, NAV_TIMEOUT, type BrowserEngine } from "./launcher.js";
import { acquireSessionContext, releaseSessionContext } from "./runtime.js";
import { profileUserDataDir } from "./profile-store.js";
import {
  formatRecentDownloads,
  getDownloadApprovalBinding,
  installDownloadHandler,
  releaseQuarantinedDownload,
  type DownloadApprovalBinding,
} from "./downloads.js";
import { injectTokenIfLocal } from "./auth-context.js";
import { safeHost, redirectMessage } from "./redirect.js";
import { safeBrowserPageLabel, sensitivePageStub } from "./guards.js";
import { getRuntimeConfig } from "../config.js";
import {
  extractTextFrom, screenshotAsBase64, evaluateScript,
  listTabs as listTabsOp, resolveSwitchTab, pageInfo,
  type ScreenshotResult,
} from "./page-ops.js";
import { isBlankish } from "./blankish.js";
import type { BrowserMode } from "../types.js";
import { waitForContinuityCacheRestore } from "./continuity-cache.js";
import type { BrowserBackend, InteractionResult, ScrollOptions } from "./backend.js";

/**
 * Per-session browser surface. Each session owns its own tabs + observation
 * registry inside the shared Chrome (see runtime.ts), so a mission navigating
 * mid-task can't move the tab or reassign the refs another session is using.
 * The Chrome process and connection are NOT owned here — close() only tears
 * down this session's tabs (and its own context in isolated mode).
 */
export class BrowserManager implements BrowserBackend {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private owned: Page[] = [];
  private currentEngine: BrowserEngine = "chromium";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private registry = new ObservationRegistry();
  private onIdle: (() => void) | null = null;
  private peerPages: (() => Page[]) | null = null;
  private popupWiredContexts = new WeakSet<BrowserContext>();

  constructor(
    private readonly sessionId: string = "default",
    private readonly mode: BrowserMode = "isolated",
    // Profile binding (see backend.ts). CDP maps it to a userDataDir later.
    private readonly profileId: string = "default",
  ) {}

  getProfileId(): string { return this.profileId; }
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
    installDownloadHandler(p, this.sessionId);
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
      if (sensitivePageStub(this.page.url())) {
        this.armIdle();
        return this.page;
      }
      try {
        await this.page.title();
        this.armIdle();
        return this.page;
      } catch {
        this.page = null;
        this.context = null;
      }
    }

    // Bind the shared Chrome to THIS session's profile dir. On the CDP backend
    // the profile's userDataDir is what holds its logins/cookies, so the CDP
    // twin of a profile stays logged in across restarts and mirrors the in-app
    // partition. The default profile aliases the legacy shared dir, so default
    // sessions are byte-for-byte unchanged. (Shared-Chrome caveat: one Chrome
    // process = one userDataDir, so the FIRST session to launch the shared
    // browser fixes it for concurrent CDP sessions — see runtime.getSharedBrowser.)
    this.context = await acquireSessionContext(
      this.currentEngine,
      this.mode,
      this.sessionId,
      profileUserDataDir(this.profileId),
    );
    // Install the context-level SSRF/scheme request guard so EVERY navigation
    // this context makes (click/act/fill-induced, redirect hop, JS-redirect) is
    // egress-checked at the request layer — not just the initial navigate URL.
    // Idempotent: guards each context at most once (shared mode reuses one).
    await installRequestGuard(this.context);
    // Adopt site-opened popups (window.open / target=_blank) into `owned`.
    // Accessors, not `this.owned` by ref — newTab reassigns it on cleanup.
    wirePopupAdoption(this.context, {
      wired: this.popupWiredContexts,
      isOwned: (p) => this.owned.includes(p),
      addOwned: (p) => { this.owned.push(p); },
      peers: () => (this.peerPages ? this.peerPages() : []),
      adopt: (p) => this.adoptPage(p),
    });
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
    // Any failure AFTER the page is created — goto (DNS/timeout/egress-abort),
    // continuity restore, or a page that self-closes on an OAuth/redirect
    // bounce before bringToFront/title — must unwind the just-pushed page so it
    // never strands in `owned`, and this.page is never left pointing at a dead
    // tab. (Previously only a throwing goto was unwound.)
    const unwind = async () => {
      this.owned = this.owned.filter((p) => p !== newPage);
      if (this.page === newPage) this.page = null;
      try { await newPage.close(); } catch { /* already closed */ }
    };
    try {
      const response = await newPage.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      if (this.mode === "continuity") await waitForContinuityCacheRestore(newPage);
      const status = response?.status() ?? "unknown";
      // Same HTTP ≥400 guard as navigate() — reporting "Status: 404" as success
      // let the agent interact with an error page. Unwind, then surface a throw.
      if (typeof status === "number" && status >= 400) {
        const failedUrl = newPage.url();
        await unwind();
        throw new Error(`Navigation failed: HTTP ${status} (${safeBrowserPageLabel(failedUrl)})`);
      }
      const sensitive = sensitivePageStub(newPage.url());
      try { await newPage.waitForLoadState("load", { timeout: 5000 }); } catch { /* load timeout ok */ }
      await newPage.waitForTimeout(1000);
      this.page = newPage;
      await newPage.bringToFront();
      if (sensitive) return sensitive;
      const title = await newPage.title();
      const tabCount = this.listOwnedPages().length;
      const redirect = redirectMessage(requestedHost, safeHost(newPage.url()));
      return `Opened new tab (${tabCount} tabs total)\nURL: ${newPage.url()}\nStatus: ${status}\nTitle: ${title}${redirect}`;
    } catch (error) {
      if (this.owned.includes(newPage)) await unwind();
      throw error;
    }
  }

  async navigate(url: string, engine?: BrowserEngine): Promise<string> {
    url = injectTokenIfLocal(url);
    const requestedHost = safeHost(url);
    const page = await this.getPage(engine);
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    if (this.mode === "continuity") await waitForContinuityCacheRestore(page);
    const status = response?.status() ?? "unknown";
    // HTTP error responses (404, 500, etc.) are NOT a successful navigation
    // outcome — silently returning "Status: 404" as ok let agents treat broken
    // pages as live. Surface via thrown Error so the outer handler converts to err().
    if (typeof status === "number" && status >= 400) {
      throw new Error(`Navigation failed: HTTP ${status} (${safeBrowserPageLabel(page.url())})`);
    }
    const sensitive = sensitivePageStub(page.url());
    try { await page.waitForLoadState("load", { timeout: 5000 }); } catch { /* load timeout ok */ }
    await page.waitForTimeout(1000);

    if (sensitive) return sensitive;
    const title = await page.title();
    const redirect = redirectMessage(requestedHost, safeHost(page.url()));
    // Deliberately NO snapshot here: handleNavigate appends the canonical
    // post-action snapshot (auth-wall prefix + external-content wrap).
    // Snapshotting here too ran a second full DOM extract + iframe traversal
    // on every navigate whose output was just "page unchanged" noise.
    return `Navigated to: ${page.url()}\nStatus: ${status}\nTitle: ${title}${redirect}`;
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

  // Bodies live in interactions.ts (see its header comment for semantics).
  async fingerprint(): Promise<string> {
    try {
      return await fingerprintPage(await this.getPage());
    } catch {
      return "";
    }
  }

  async scroll(opts: ScrollOptions): Promise<string> {
    return scrollPage(await this.getPage(), this.registry, opts);
  }

  async clickByRef(ref: number): Promise<InteractionResult> {
    return clickRefOn(await this.getPage(), this.registry, ref);
  }

  async fillByRef(ref: number, value: string): Promise<InteractionResult> {
    return fillRefOn(await this.getPage(), this.registry, ref, value);
  }

  async clickByText(text: string): Promise<InteractionResult> {
    return clickTextOn(await this.getPage(), this.registry, text);
  }

  // Console/network capture rides the desktop's WebContentsView plumbing —
  // not-supported strings here, honestly (matches the in-app dialog stubs).
  async readConsole(): Promise<string> {
    return (
      "Console capture is not supported on the external-Chrome backend — " +
      "it is available in the in-app browser. No console output was read."
    );
  }
  async readNetwork(): Promise<string> {
    return (
      "Network capture is not supported on the external-Chrome backend — " +
      "it is available in the in-app browser. No network activity was read."
    );
  }

  async dialogAccept(promptText?: string): Promise<string> {
    const page = await this.getPage();
    return handleNextDialog(page, "accept", promptText);
  }
  async dialogDismiss(): Promise<string> {
    const page = await this.getPage();
    return handleNextDialog(page, "dismiss");
  }
  async extractText(selector?: string, find?: string): Promise<string> {
    return extractTextFrom(await this.getPage(), selector, find);
  }
  async screenshot(): Promise<ScreenshotResult> {
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
  getDownloads(): string { return formatRecentDownloads(this.sessionId); }
  getDownloadApproval(id: string): DownloadApprovalBinding {
    return getDownloadApprovalBinding(this.sessionId, id);
  }
  async releaseDownload(id: string, approved: DownloadApprovalBinding): Promise<string> {
    const record = await releaseQuarantinedDownload(this.sessionId, id, approved);
    return `RELEASED: ${record.filename} (${record.size} bytes)\nReleased to: ${record.releasePath}`;
  }

  /** Tear down only this session's tabs + refs. The shared Chrome stays up;
   *  in isolated mode the session's own context is closed too. */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Cache Storage can only be read through a live page. Continuity must
    // serialize and close the context before its owned tabs are torn down.
    if (this.context && this.mode === "continuity") {
      await releaseSessionContext(this.context, this.mode);
      this.context = null;
      this.page = null;
      this.owned = [];
      this.registry.reset();
      return;
    }
    this.registry.reset();
    for (const p of this.owned) {
      try { if (!p.isClosed()) await p.close(); } catch { /* already closed */ }
    }
    this.owned = [];
    if (this.context) await releaseSessionContext(this.context, this.mode);
    this.context = null;
    this.page = null;
  }

  isActive(): boolean {
    return this.page !== null && !this.page.isClosed();
  }
}
