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
import { join } from "node:path";
import { homedir } from "node:os";
import { getRuntimeConfig } from "../config.js";

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

export function findChromeExecutable(): string | null {
  const candidates = [
    join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
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
    const cdpPort = getRuntimeConfig().browserCdpPort;
    const userDataDir = join(homedir(), ".sax", "chrome-profile");
    if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true });
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;

    // Reconnect to an existing agent Chrome if one is running.
    try {
      const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        await res.json();
        const browser = await pw.chromium.connectOverCDP(cdpUrl);
        console.log(`[browser] Reconnected to existing agent Chrome on port ${cdpPort}`);
        return { browser, chromeProcess: null };
      }
    } catch {
      // Not running; we'll launch fresh.
    }

    // Spawn a fully separate Chrome process. On Windows, Chrome merges into
    // the user's main instance unless we force a distinct profile + flags.
    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-process-per-site",
      "--disable-features=RendererCodeIntegrity",
      ...STEALTH_ARGS,
      "--window-size=1280,800",
    ];

    console.log(`[browser] Spawning agent Chrome: ${chromePath} (profile: ${userDataDir})`);
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
        console.log(`[browser] Connected via CDP on port ${cdpPort} — dedicated agent Chrome session`);
        return { browser, chromeProcess };
      } catch (e) {
        console.log(`[browser] CDP connect failed: ${(e as Error).message}`);
        try { chromeProcess.kill(); } catch { /* ignore */ }
        chromeProcess = null;
      }
    } else {
      console.log("[browser] Agent Chrome CDP didn't become ready in time — falling back to Playwright");
      try { chromeProcess?.kill(); } catch { /* ignore */ }
      chromeProcess = null;
    }
  }

  // Fallback: Playwright persistent context.
  console.log("[browser] Launching Playwright persistent context");
  const persistDir = join(homedir(), ".sax", "chrome-profile-pw");
  if (!existsSync(persistDir)) mkdirSync(persistDir, { recursive: true });
  try {
    const ctx = await pw.chromium.launchPersistentContext(persistDir, {
      channel: "chrome",
      headless: false,
      args: STEALTH_ARGS,
      viewport: { width: 1280, height: 800 },
    });
    console.log("[browser] Playwright persistent context (Chrome channel)");
    return { browser: ctx.browser()!, chromeProcess: null };
  } catch {
    try {
      const ctx = await pw.chromium.launchPersistentContext(persistDir, {
        headless: false,
        args: STEALTH_ARGS,
        viewport: { width: 1280, height: 800 },
      });
      console.log("[browser] Playwright persistent context (bundled Chromium)");
      return { browser: ctx.browser()!, chromeProcess: null };
    } catch {
      const b = await pw.chromium.launch({ headless: false, args: STEALTH_ARGS });
      console.log(`[browser] Playwright Chromium (no persistence) v${b.version()}`);
      return { browser: b, chromeProcess: null };
    }
  }
}
