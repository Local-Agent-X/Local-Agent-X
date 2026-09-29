import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { getLaxDir } from "../lax-data-dir.js";
import type { BrowserMode } from "../types.js";
import { startBrowserEgressProxy, type BrowserEgressProxy } from "./egress-proxy.js";
import { launchAgentChrome, type BrowserEngine, type LaunchResult } from "./launcher.js";
import type { BrowserContextRuntime } from "./manager.js";

export function windowsChatChromeProfileDir(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return join(getLaxDir(), "chrome-chat-profiles", digest);
}

interface RuntimeDependencies {
  startProxy: () => Promise<BrowserEgressProxy>;
  loadPlaywright: () => Promise<typeof import("playwright")>;
  launch: typeof launchAgentChrome;
}

const defaultDependencies: RuntimeDependencies = {
  startProxy: () => startBrowserEgressProxy(),
  loadPlaywright: () => import("playwright"),
  launch: launchAgentChrome,
};

export class WindowsChatChromeRuntime implements BrowserContextRuntime {
  private launchPromise: Promise<BrowserContext> | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launchCleanup: (() => Promise<void>) | null = null;
  private proxy: BrowserEgressProxy | null = null;

  constructor(
    readonly sessionId: string,
    readonly profileDir = windowsChatChromeProfileDir(sessionId),
    private readonly dependencies: RuntimeDependencies = defaultDependencies,
  ) {}

  async acquire(
    engine: BrowserEngine,
    _mode: BrowserMode,
    _ownerId: string,
    _userDataDir?: string,
  ): Promise<BrowserContext> {
    if (engine !== "chromium") throw new Error("Windows chat Chrome supports only the Chromium engine");
    if (this.context && this.browser?.isConnected()) return this.context;
    if (!this.launchPromise) {
      this.launchPromise = this.launchChrome().finally(() => { this.launchPromise = null; });
    }
    return this.launchPromise;
  }

  private async launchChrome(): Promise<BrowserContext> {
    this.proxy = await this.dependencies.startProxy();
    try {
      const pw = await this.dependencies.loadPlaywright();
      const result: LaunchResult = await this.dependencies.launch(pw, this.proxy.url, {
        userDataDir: this.profileDir,
        persistentDataDir: this.profileDir,
        forceProfileLaunch: true,
      });
      this.browser = result.browser;
      this.launchCleanup = result.cleanup ?? null;
      this.context = result.browser.contexts()[0] ?? await result.browser.newContext();
      return this.context;
    } catch (error) {
      const browser = this.browser;
      const cleanup = this.launchCleanup;
      this.browser = null;
      this.context = null;
      this.launchCleanup = null;
      if (browser) await browser.close().catch(() => {});
      if (cleanup) await cleanup().catch(() => {});
      await this.proxy.close().catch(() => {});
      this.proxy = null;
      throw error;
    }
  }

  async release(_context: BrowserContext, _mode: BrowserMode): Promise<void> {
    await this.close();
  }

  async reset(): Promise<void> {
    const browser = this.browser;
    const cleanup = this.launchCleanup;
    const proxy = this.proxy;
    this.browser = null;
    this.context = null;
    this.launchCleanup = null;
    this.proxy = null;
    if (cleanup) await cleanup().catch(() => {});
    if (browser) void browser.close().catch(() => {});
    if (proxy) await proxy.close().catch(() => {});
  }

  private async close(): Promise<void> {
    const browser = this.browser;
    const cleanup = this.launchCleanup;
    const proxy = this.proxy;
    this.browser = null;
    this.context = null;
    this.launchCleanup = null;
    this.proxy = null;
    if (browser) await browser.close().catch(() => {});
    if (cleanup) await cleanup();
    if (proxy) await proxy.close();
  }
}
