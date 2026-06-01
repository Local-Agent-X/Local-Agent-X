/**
 * Shared browser runtime — owns the single Chrome process + CDP connection
 * that every session draws its tabs from. One Chrome, many per-session tabs:
 * this holds the process-global half (the Browser connection and the spawned
 * Chrome process), while page + ref state lives per session in BrowserManager.
 *
 * A session's tab lives in either the shared default context (cookies/logins
 * shared across sessions — the continuity default) or its own context
 * (separate cookie jar) when browserPerSessionContext is on.
 */
import type { Browser, BrowserContext } from "playwright";
import type { ChildProcess } from "node:child_process";
import { launchViaCDP, STEALTH_ARGS, USER_AGENTS, type BrowserEngine } from "./launcher.js";
import { createLogger } from "../logger.js";

const log = createLogger("browser.runtime");

let browser: Browser | null = null;
let chromeProcess: ChildProcess | null = null;
let currentEngine: BrowserEngine = "chromium";
// Dedupe concurrent launches: two sessions calling getSharedBrowser() before
// Chrome is up must await the same spawn, not race two Chrome processes.
let launching: Promise<Browser> | null = null;

async function launch(engine: BrowserEngine): Promise<Browser> {
  const pw = await import("playwright");
  if (engine === "chromium") {
    const { browser: b, chromeProcess: proc } = await launchViaCDP(pw);
    chromeProcess = proc;
    return b;
  }
  return pw[engine].launch({ headless: false, args: STEALTH_ARGS });
}

/** The single Chrome connection, launched on first use. Switching engines
 *  closes the current browser and relaunches. */
export async function getSharedBrowser(engine: BrowserEngine): Promise<Browser> {
  if (browser && browser.isConnected() && engine !== currentEngine) {
    await closeSharedBrowser();
  }
  currentEngine = engine;
  if (browser && browser.isConnected()) return browser;
  if (!launching) {
    launching = launch(engine)
      .then((b) => { browser = b; return b; })
      .finally(() => { launching = null; });
  }
  return launching;
}

const CONTEXT_OPTS = (engine: BrowserEngine) => ({
  userAgent: USER_AGENTS[engine],
  viewport: { width: 1280, height: 800 },
  locale: "en-US",
  timezoneId: "America/Chicago",
});

/**
 * The context a session's tabs should live in. Shared mode reuses Chrome's
 * default context (one cookie jar for all sessions); isolated mode mints a
 * fresh context per call (separate cookie jar). CDP-connected Chrome only
 * exposes its default context for sharing, so the UA/locale overrides apply
 * only when we actually create a context.
 */
export async function acquireSessionContext(
  engine: BrowserEngine,
  isolated: boolean
): Promise<BrowserContext> {
  const b = await getSharedBrowser(engine);
  if (isolated) {
    return b.newContext(CONTEXT_OPTS(engine));
  }
  const existing = b.contexts();
  if (existing.length > 0) return existing[0];
  return b.newContext(CONTEXT_OPTS(engine));
}

export function getRuntimeEngine(): BrowserEngine { return currentEngine; }

export function sharedBrowserActive(): boolean {
  return browser !== null && browser.isConnected();
}

export async function closeSharedBrowser(): Promise<void> {
  if (browser) {
    try { await browser.close(); } catch { /* already gone */ }
    browser = null;
  }
  if (chromeProcess) {
    try { chromeProcess.kill(); } catch { /* already exited */ }
    chromeProcess = null;
  }
  log.info("[browser-runtime] shared Chrome closed");
}
