/**
 * Shared browser runtime — owns the single Chrome process + CDP connection
 * that every session draws its tabs from. One Chrome, many per-session tabs:
 * this holds the process-global half (the Browser connection and the spawned
 * Chrome process), while page + ref state lives per session in BrowserManager.
 *
 * A session's tab lives in an ephemeral context (isolation), a serialized
 * persistent identity context (continuity), or an explicitly shared live
 * context (advanced-shared).
 */
import type { Browser, BrowserContext, BrowserContextOptions, CDPSession } from "playwright";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  browserProxyConfig,
  launchViaCDP,
  SERVICE_WORKER_POLICY,
  STEALTH_ARGS,
  USER_AGENTS,
  type BrowserEngine,
} from "./launcher.js";
import { closeBrowserEgressProxy, ensureBrowserEgressProxy } from "./egress-proxy.js";
import { createLogger } from "../logger.js";
import { getLaxDir } from "../lax-data-dir.js";
import type { BrowserMode } from "../types.js";
import { installContinuityCacheRestore, persistContinuityCacheState } from "./continuity-cache.js";
import { getBrowserNativeDownloadDir, resetBrowserNativeDownloadDir } from "./download-paths.js";

const log = createLogger("browser.runtime");

let browser: Browser | null = null;
let chromeProcess: ChildProcess | null = null;
let browserLaunchCleanup: (() => Promise<void>) | null = null;
let currentEngine: BrowserEngine = "chromium";
let sharedContext: BrowserContext | null = null;
let sharedContextCreation: Promise<BrowserContext> | null = null;
let continuityContext: BrowserContext | null = null;
let continuityOwner: string | null = null;
let continuityTransition: Promise<void> = Promise.resolve();
let proxyServer: string | null = null;
// Dedupe concurrent launches: two sessions calling getSharedBrowser() before
// Chrome is up must await the same spawn, not race two Chrome processes.
let launching: Promise<Browser> | null = null;
let contextCreationTail: Promise<void> = Promise.resolve();
const contextDownloadSessions = new WeakMap<BrowserContext, CDPSession>();

export function createQuarantinedChromiumContext(
  browserInstance: Browser,
  options: BrowserContextOptions,
  downloadsPath = getBrowserNativeDownloadDir(),
): Promise<BrowserContext> {
  const create = contextCreationTail.then(async () => {
    const session = await browserInstance.newBrowserCDPSession();
    let context: BrowserContext | null = null;
    try {
      const before = await session.send("Target.getBrowserContexts") as { browserContextIds: string[] };
      context = await browserInstance.newContext(options);
      const after = await session.send("Target.getBrowserContexts") as { browserContextIds: string[] };
      const added = after.browserContextIds.filter((id) => !before.browserContextIds.includes(id));
      if (added.length !== 1) {
        await context.close();
        throw new Error("Could not identify the new Chrome browser context for private download configuration.");
      }
      await session.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: downloadsPath,
        browserContextId: added[0],
        eventsEnabled: true,
      });
      contextDownloadSessions.set(context, session);
      return context;
    } catch (error) {
      await context?.close().catch(() => {});
      await session.detach().catch(() => {});
      throw error;
    }
  });
  contextCreationTail = create.then(() => undefined, () => undefined);
  return create;
}

async function launch(engine: BrowserEngine, userDataDir?: string): Promise<Browser> {
  const proxy = await ensureBrowserEgressProxy();
  proxyServer = proxy.url;
  const pw = await import("playwright");
  try {
    if (engine === "chromium") {
      // userDataDir carries the launching session's browser-profile dir. The
      // launcher keeps its own legacy default when this is undefined, so a
      // direct/legacy call is unchanged.
      const { browser: b, chromeProcess: proc, cleanup } = await launchViaCDP(pw, proxy.url, { userDataDir });
      chromeProcess = proc;
      browserLaunchCleanup = cleanup ?? null;
      return b;
    }
    return pw[engine].launch({
      headless: process.env.LAX_BROWSER_HEADLESS === "1",
      args: STEALTH_ARGS,
      downloadsPath: resetBrowserNativeDownloadDir(),
      proxy: browserProxyConfig(proxy.url),
    });
  } catch (error) {
    proxyServer = null;
    await closeBrowserEgressProxy();
    throw error;
  }
}

/** The single Chrome connection, launched on first use. Switching engines
 *  closes the current browser and relaunches.
 *
 *  `userDataDir` is the CDP profile dir of the session triggering the launch.
 *  Because there is exactly ONE shared Chrome process (and a Chrome process
 *  owns a single --user-data-dir), the FIRST session to launch fixes the dir
 *  for every concurrent CDP session until the shared browser is torn down. That
 *  is the accepted CDP-fallback limitation: true per-(session,profile) browsing
 *  is the in-app backend's job (isolated WebContentsView partitions); CDP is the
 *  single-profile fallback that at least persists the driving profile's logins.
 *  An already-connected browser ignores the arg (its dir is already committed). */
export async function getSharedBrowser(engine: BrowserEngine, userDataDir?: string): Promise<Browser> {
  if (browser && browser.isConnected() && engine !== currentEngine) {
    await closeSharedBrowser();
  }
  currentEngine = engine;
  if (browser && browser.isConnected()) return browser;
  sharedContext = null;
  sharedContextCreation = null;
  if (!launching) {
    launching = launch(engine, userDataDir)
      .then((b) => { browser = b; return b; })
      .finally(() => { launching = null; });
  }
  return launching;
}

const CONTEXT_OPTS = (engine: BrowserEngine) => {
  if (!proxyServer) throw new Error("Browser egress proxy is unavailable");
  return {
    userAgent: USER_AGENTS[engine],
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/Chicago",
    serviceWorkers: SERVICE_WORKER_POLICY,
    acceptDownloads: true,
    proxy: browserProxyConfig(proxyServer),
  };
};

/**
 * The context a session's tabs should live in. Shared mode reuses one cookie
 * jar for all sessions; isolated mode mints a fresh context per call. The CDP
 * default context cannot be configured to block Service Workers after launch,
 * so it is never handed to a manager; shared mode caches an explicitly
 * configured context instead.
 */
const continuityStatePath = (): string => join(getLaxDir(), "browser-continuity-state.json");
const continuityCachePath = (): string => join(getLaxDir(), "browser-continuity-cache-state.json");

export class BrowserContinuityPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BrowserContinuityPersistenceError";
  }
}

export async function persistBrowserContextState(
  context: BrowserContext,
  statePath: string,
): Promise<void> {
  const tempPath = `${statePath}.tmp`;
  try {
    await context.storageState({ path: tempPath, indexedDB: true });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, statePath);
  } catch (error) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* best-effort */ }
    const detail = error instanceof Error ? error.message : String(error);
    log.error(`[browser-runtime] continuity state save failed: ${detail}`);
    throw new BrowserContinuityPersistenceError(
      `Could not save the dedicated continuity browser identity: ${detail}`,
      { cause: error },
    );
  }
}

async function persistContinuityContext(context: BrowserContext): Promise<void> {
  await persistBrowserContextState(context, continuityStatePath());
  try {
    await persistContinuityCacheState(context, continuityCachePath());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BrowserContinuityPersistenceError(
      `Could not save the dedicated continuity browser cache identity: ${detail}`,
      { cause: error },
    );
  }
}

export async function acquireSessionContext(
  engine: BrowserEngine,
  mode: BrowserMode,
  ownerId: string,
  userDataDir?: string,
): Promise<BrowserContext> {
  const b = await getSharedBrowser(engine, userDataDir);
  if (mode === "isolated") {
    return engine === "chromium"
      ? createQuarantinedChromiumContext(b, CONTEXT_OPTS(engine))
      : b.newContext(CONTEXT_OPTS(engine));
  }
  if (mode === "continuity") {
    const operation = continuityTransition.then(async () => {
      if (continuityContext && continuityOwner === ownerId) return continuityContext;
      if (continuityContext) {
        await persistContinuityContext(continuityContext);
        await continuityContext.close();
        continuityContext = null;
        continuityOwner = null;
      }
      const statePath = continuityStatePath();
      const continuityOptions = {
        ...CONTEXT_OPTS(engine),
        ...(existsSync(statePath) ? { storageState: statePath } : {}),
      };
      continuityContext = engine === "chromium"
        ? await createQuarantinedChromiumContext(b, continuityOptions)
        : await b.newContext(continuityOptions);
      await installContinuityCacheRestore(continuityContext, continuityCachePath());
      continuityOwner = ownerId;
      return continuityContext;
    });
    continuityTransition = operation.then(() => undefined, () => undefined);
    return operation;
  }
  if (sharedContext) return sharedContext;
  if (!sharedContextCreation) {
    const creation = engine === "chromium"
      ? createQuarantinedChromiumContext(b, CONTEXT_OPTS(engine))
      : b.newContext(CONTEXT_OPTS(engine));
    sharedContextCreation = creation
      .then((context) => { sharedContext = context; return context; })
      .finally(() => { sharedContextCreation = null; });
  }
  return sharedContextCreation;
}

export async function releaseSessionContext(
  context: BrowserContext,
  mode: BrowserMode,
): Promise<void> {
  if (mode === "advanced-shared") return;
  if (mode === "continuity") {
    const operation = continuityTransition.then(async () => {
      // A newer owner may already have persisted and closed this context.
      // The stale manager must not try to serialize the closed predecessor.
      if (continuityContext !== context) return;
      await persistContinuityContext(context);
      await context.close();
      continuityContext = null;
      continuityOwner = null;
    });
    continuityTransition = operation.then(() => undefined, () => undefined);
    await operation;
    return;
  }
  await context.close();
}

export function getRuntimeEngine(): BrowserEngine { return currentEngine; }

export function sharedBrowserActive(): boolean {
  return browser !== null && browser.isConnected();
}

export async function closeSharedBrowser(): Promise<void> {
  sharedContext = null;
  sharedContextCreation = null;
  if (continuityContext) await persistContinuityContext(continuityContext);
  continuityContext = null;
  continuityOwner = null;
  if (browser) {
    try { await browser.close(); } catch { /* already gone */ }
    browser = null;
  }
  if (browserLaunchCleanup) {
    await browserLaunchCleanup();
    browserLaunchCleanup = null;
  } else if (chromeProcess) {
    try { chromeProcess.kill(); } catch { /* already exited */ }
  }
  chromeProcess = null;
  proxyServer = null;
  await closeBrowserEgressProxy();
  log.info("[browser-runtime] shared Chrome closed");
}

/**
 * Wedge recovery (no graceful await). A hung CDP op — e.g. an `observe()` that
 * never returns — leaves `browser.isConnected()` true, so the connection is
 * reused forever and only a process restart clears it. We can't `await
 * browser.close()` here: on a wedged connection that close can itself hang.
 * Instead SIGKILL the agent Chrome process and drop the handles immediately;
 * the next `getSharedBrowser()` relaunches, and any in-flight op on the dead
 * connection rejects promptly ("Target closed"). Only touches the agent's
 * dedicated Chrome — never the user's.
 */
export function forceKillSharedBrowser(): void {
  const proc = chromeProcess;
  const b = browser;
  const cleanup = browserLaunchCleanup;
  chromeProcess = null;
  browserLaunchCleanup = null;
  browser = null;
  sharedContext = null;
  sharedContextCreation = null;
  continuityContext = null;
  continuityOwner = null;
  proxyServer = null;
  if (cleanup) void cleanup().catch(() => { /* best-effort wedge recovery */ });
  else if (proc) { try { proc.kill("SIGKILL"); } catch { /* already exited */ } }
  if (b) { void b.close().catch(() => { /* connection already dead */ }); }
  void closeBrowserEgressProxy().catch((error) => {
    log.warn(`[browser-runtime] browser proxy close failed: ${(error as Error).message}`);
  });
  log.info("[browser-runtime] shared Chrome force-killed (wedge recovery)");
}
