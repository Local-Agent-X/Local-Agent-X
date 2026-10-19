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

/** Every runtime that has launched, or is launching, a Chrome on a profile dir,
 *  until it is stopped: what stopChromesOnProfileDir waits out. */
const liveByProfileDir = new Map<string, Set<WindowsChatChromeRuntime>>();

/** Stop every Chrome on a profile dir and resolve once each is gone, including
 *  one still launching and one another caller is already closing — so nothing
 *  is writing the dir when the caller removes it (job-browser-profile.ts). */
export async function stopChromesOnProfileDir(profileDir: string): Promise<void> {
  await Promise.all([...(liveByProfileDir.get(profileDir) ?? [])].map((runtime) => runtime.stop()));
}

export class WindowsChatChromeRuntime implements BrowserContextRuntime {
  private launchPromise: Promise<BrowserContext> | null = null;
  private stopping: Promise<void> | null = null;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launchCleanup: (() => Promise<void>) | null = null;
  private proxy: BrowserEgressProxy | null = null;

  constructor(
    readonly sessionId: string,
    readonly profileDir = windowsChatChromeProfileDir(sessionId),
    private readonly dependencies: RuntimeDependencies = defaultDependencies,
    /** Throws when no Chrome may launch on the profile now (a deleted job's). */
    private readonly checkLaunch: () => void = () => {},
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
      this.checkLaunch();
      let live = liveByProfileDir.get(this.profileDir);
      if (!live) liveByProfileDir.set(this.profileDir, live = new Set());
      live.add(this);
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
    await this.stop();
  }

  /** Close this Chrome once any launch in flight lands (else it would come up
   *  after the close, with nobody owning it). Concurrent callers share the one
   *  stop, so each resolves only when the process is gone. */
  stop(): Promise<void> {
    this.stopping ??= this.close().finally(() => { this.stopping = null; });
    return this.stopping;
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
    if (this.launchPromise) await this.launchPromise.catch(() => {});
    const browser = this.browser;
    const cleanup = this.launchCleanup;
    const proxy = this.proxy;
    this.browser = null;
    this.context = null;
    this.launchCleanup = null;
    this.proxy = null;
    try {
      if (browser) await browser.close().catch(() => {});
      if (cleanup) await cleanup();
      if (proxy) await proxy.close();
    } finally {
      // Gone only once the process is; a launch begun meanwhile keeps it live.
      const live = liveByProfileDir.get(this.profileDir);
      if (live && !this.launchPromise && !this.browser) {
        live.delete(this);
        if (live.size === 0) liveByProfileDir.delete(this.profileDir);
      }
    }
  }
}
