import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import { getLaxDir } from "../lax-data-dir.js";
import type { BrowserMode } from "../types.js";
import { startBrowserEgressProxy, type BrowserEgressProxy } from "./egress-proxy.js";
import { launchViaCDP, type BrowserEngine, type LaunchResult } from "./launcher.js";
import type { BrowserContextRuntime } from "./manager.js";

export function windowsChatChromeProfileDir(sessionId: string): string {
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  return join(getLaxDir(), "chrome-chat-profiles", digest);
}

export async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a Chrome debugging port");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

interface RuntimeDependencies {
  startProxy: () => Promise<BrowserEgressProxy>;
  allocatePort: () => Promise<number>;
  loadPlaywright: () => Promise<typeof import("playwright")>;
  launch: typeof launchViaCDP;
}

const defaultDependencies: RuntimeDependencies = {
  startProxy: () => startBrowserEgressProxy(),
  allocatePort: reserveLoopbackPort,
  loadPlaywright: () => import("playwright"),
  launch: launchViaCDP,
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
      const [pw, cdpPort] = await Promise.all([
        this.dependencies.loadPlaywright(),
        this.dependencies.allocatePort(),
      ]);
      const result: LaunchResult = await this.dependencies.launch(pw, this.proxy.url, {
        cdpPort,
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
