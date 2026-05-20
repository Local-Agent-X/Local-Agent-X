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
import { homedir } from "node:os";
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
  "--disable-features=Translate,MediaRouter",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--password-store=basic",
  "--disable-infobars",
];

/**
 * Path to the user's real Chrome user-data dir. Attach mode launches against
 * this so the agent inherits cookies/logins from the user's personal browsing.
 * Chrome refuses to start a second instance on a profile that's already open,
 * so attach mode requires the user's regular Chrome to be closed.
 */
export function findUserChromeProfile(): string | null {
  const home = homedir();
  const candidates = process.platform === "win32"
    ? [
        join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
        join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data"),
      ]
    : process.platform === "darwin"
      ? [
          join(home, "Library", "Application Support", "Google", "Chrome"),
          join(home, "Library", "Application Support", "Microsoft Edge"),
        ]
      : [
          join(home, ".config", "google-chrome"),
          join(home, ".config", "chromium"),
          join(home, ".config", "microsoft-edge"),
        ];
  for (const path of candidates) {
    if (path && existsSync(path)) return path;
  }
  return null;
}

/**
 * Detect whether a Chrome/Edge process is already running against the given
 * user-data directory. If so, attach mode must refuse to launch — Chrome
 * would either merge into the existing window or fail to start.
 */
export async function isChromeRunningOnProfile(userDataDir: string): Promise<boolean> {
  // Windows: query running processes with tasklist and look for chrome.exe/msedge.exe.
  // We can't easily match the exact profile, so any running chrome.exe is a
  // blocker — Chrome's single-instance-per-profile rule bites us either way.
  try {
    const { execSync } = await import("node:child_process");
    const isWin = process.platform === "win32";
    if (isWin) {
      const out = execSync(`tasklist /FI "IMAGENAME eq chrome.exe" /NH`, { encoding: "utf8", timeout: 3000 }).toString();
      if (/chrome\.exe/i.test(out)) return true;
      const edgeOut = execSync(`tasklist /FI "IMAGENAME eq msedge.exe" /NH`, { encoding: "utf8", timeout: 3000 }).toString();
      if (userDataDir.toLowerCase().includes("edge") && /msedge\.exe/i.test(edgeOut)) return true;
      return false;
    } else {
      const out = execSync(`pgrep -a -f chrome 2>/dev/null || true`, { encoding: "utf8", timeout: 3000 }).toString();
      return /chrome|chromium/i.test(out);
    }
  } catch {
    return false; // If we can't tell, let the launch attempt surface the real error.
  }
}

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
 * Launch Chrome via CDP (preferred) or fall back to Playwright's persistent
 * context. Returns both the browser handle and the spawned process (if any)
 * so the caller can clean it up on close.
 */
export async function launchViaCDP(
  pw: typeof import("playwright")
): Promise<LaunchResult> {
  const chromePath = findChromeExecutable();
  let chromeProcess: ChildProcess | null = null;

  if (chromePath) {
    const cfg = getRuntimeConfig();
    const cdpPort = cfg.browserCdpPort;
    const mode = cfg.browserMode || "isolated";

    // Resolve the user-data-dir based on mode.
    // - isolated: dedicated agent profile (~/.lax/chrome-profile), zero blast
    //   radius on the user's personal browsing
    // - attach: the user's real Chrome profile — agent inherits all logins,
    //   but Chrome must not already be running against that profile
    let userDataDir: string;
    if (mode === "attach") {
      const real = findUserChromeProfile();
      if (!real) {
        throw new Error(
          "Browser attach mode is enabled but no Chrome/Edge user-data directory was found. " +
          "Switch back to isolated mode in Settings → Security."
        );
      }
      const running = await isChromeRunningOnProfile(real);
      if (running) {
        throw new Error(
          "Browser attach mode requires your regular Chrome to be closed. " +
          "Chrome refuses two instances on the same profile — quit Chrome and retry, " +
          "or switch to isolated mode in Settings → Security."
        );
      }
      userDataDir = real;
      logger.info(`[browser] Attach mode — using your real Chrome profile: ${userDataDir}`);
    } else {
      userDataDir = join(homedir(), ".lax", "chrome-profile");
      if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
    }
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

    // Spawn a fully separate Chrome process. On Windows, Chrome merges into
    // the user's main instance unless we force a distinct profile + flags.
    // --download.default_directory and --disable-download-protection so
    // downloads land in workspace/downloads/ without the SmartScreen
    // confirmation dialog blocking the agent.
    const downloadsDir = resolveDownloadsDir();
    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-process-per-site",
      "--disable-features=RendererCodeIntegrity",
      ...STEALTH_ARGS,
      "--window-size=1280,800",
      `--download.default_directory=${downloadsDir}`,
      "--disable-features=DownloadBubble,DownloadBubbleV2",
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
  const persistDir = join(homedir(), ".lax", "chrome-profile-pw");
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
