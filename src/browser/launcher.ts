/**
 * Chrome/Playwright launcher — finds the right Chrome executable, spawns a
 * dedicated agent profile, and connects over CDP so we don't trip Playwright's
 * automation fingerprints.
 *
 * Extracted from browser.ts so the main manager stays under 400 LOC.
 */
import type { Browser } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { getRuntimeConfig } from "../config.js";

/** Resolve the workspace/downloads dir (creates it if missing) — shared by
 *  CDP and Playwright fallback paths so downloads land in one place. */
function resolveDownloadsDir(): string {
  const cfg = getRuntimeConfig();
  const dir = resolve(cfg.workspace, "downloads");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

import { createLogger } from "../logger.js";
const logger = createLogger("browser.launcher");

export const NAV_TIMEOUT = 30_000;
export const ACTION_TIMEOUT = 10_000;
export const MAX_TEXT_LENGTH = 8_000;

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
];

/**
 * Single source of truth for Chrome features we disable. Chrome honors only the
 * LAST `--disable-features=` flag, so every disable must live in this one list
 * and be passed as a single consolidated flag. RendererCodeIntegrity is
 * intentionally absent — disabling it weakens renderer code integrity.
 */
export const DISABLE_FEATURES = ["Translate", "MediaRouter", "DownloadBubble", "DownloadBubbleV2"] as const;

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
  pw: typeof import("playwright")
): Promise<LaunchResult> {
  const chromePath = findChromeExecutable();
  const cfg = getRuntimeConfig();
  let chromeProcess: ChildProcess | null = null;

  if (chromePath) {
    const cdpPort = cfg.browserCdpPort;
    const userDataDir = join(getLaxDir(), "chrome-profile");
    if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;

    // Reconnect to an existing agent Chrome if one is running.
    try {
      const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        await res.json();
        const browser = await pw.chromium.connectOverCDP(cdpUrl);
        logger.info(`[browser] Reconnected to existing agent Chrome on port ${cdpPort}`);
        return { browser, chromeProcess: null };
      }
    } catch {
      // Not running; we'll launch fresh.
    }

    // Spawn a fully separate Chrome process. The distinct --user-data-dir plus
    // --remote-debugging-port keep this off the user's main instance. All
    // feature-disables are consolidated into one --disable-features flag
    // (Chrome honors only the last occurrence), and --download.default_directory
    // points downloads at workspace/downloads/.
    const downloadsDir = resolveDownloadsDir();
    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      ...STEALTH_ARGS,
      "--window-size=1280,800",
      `--download.default_directory=${downloadsDir}`,
      `--disable-features=${DISABLE_FEATURES.join(",")}`,
    ];

    logger.info(`[browser] Spawning agent Chrome: ${chromePath} (profile: ${userDataDir})`);
    chromeProcess = spawn(chromePath, args, {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, CHROME_USER_DATA_DIR: userDataDir },
    });
    chromeProcess.unref();

    // Wait up to ~9s for CDP to come up.
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) { ready = true; break; }
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 300));
    }

    if (ready) {
      try {
        const browser = await pw.chromium.connectOverCDP(cdpUrl);
        logger.info(`[browser] Connected via CDP on port ${cdpPort} — dedicated agent Chrome session`);
        return { browser, chromeProcess };
      } catch (e) {
        logger.info(`[browser] CDP connect failed: ${(e as Error).message}`);
        try { chromeProcess.kill(); } catch { /* ignore */ }
        chromeProcess = null;
      }
    } else {
      logger.info("[browser] Agent Chrome CDP didn't become ready in time — falling back to Playwright");
      try { chromeProcess?.kill(); } catch { /* ignore */ }
      chromeProcess = null;
    }
  }

  // Fallback: Playwright persistent context. acceptDownloads + downloadsPath
  // so Playwright doesn't abort navigation when a response is a download
  // (the failure mode that landed files nowhere pre-2026-05-19).
  logger.info("[browser] Launching Playwright persistent context");
  const persistDir = join(getLaxDir(), "chrome-profile-pw");
  if (!existsSync(persistDir)) mkdirSync(persistDir, { recursive: true });
  const downloadsDir = resolveDownloadsDir();
  try {
    const ctx = await pw.chromium.launchPersistentContext(persistDir, {
      channel: "chrome",
      headless: false,
      args: STEALTH_ARGS,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      downloadsPath: downloadsDir,
    });
    logger.info("[browser] Playwright persistent context (Chrome channel)");
    return { browser: ctx.browser()!, chromeProcess: null };
  } catch {
    try {
      const ctx = await pw.chromium.launchPersistentContext(persistDir, {
        headless: false,
        args: STEALTH_ARGS,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        downloadsPath: downloadsDir,
      });
      logger.info("[browser] Playwright persistent context (bundled Chromium)");
      return { browser: ctx.browser()!, chromeProcess: null };
    } catch {
      const b = await pw.chromium.launch({ headless: false, args: STEALTH_ARGS });
      logger.info(`[browser] Playwright Chromium (no persistence) v${b.version()}`);
      return { browser: b, chromeProcess: null };
    }
  }
}
