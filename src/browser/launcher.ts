/**
 * Chrome/Playwright launcher — finds the right Chrome executable, spawns a
 * dedicated agent profile, and connects over CDP so we don't trip Playwright's
 * automation fingerprints.
 *
 * Extracted from browser.ts so the main manager stays under 400 LOC.
 */
import type { Browser } from "playwright";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, lstatSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
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
 * The most reliable "this profile is in use" signal: Chrome writes a
 * `SingletonLock` symlink (`hostname-PID`) into the user-data dir while it owns
 * the profile, and leaves it there for any lingering background process too.
 * This is profile-specific (unlike a process scan) and catches the macOS case
 * that bit attach mode: the user closes every Chrome window but a background
 * helper keeps the lock, so a fresh `--user-data-dir` launch silently hands off
 * to that instance and never brings up CDP.
 *
 * Returns true only when the lock exists AND its PID is still alive (a crashed
 * Chrome leaves a stale lock we must not treat as "running"). Windows uses a
 * plain `lockfile` with no PID, so its presence alone counts.
 */
function isProfileLocked(userDataDir: string): boolean {
  if (process.platform === "win32") {
    return existsSync(join(userDataDir, "lockfile"));
  }
  const lock = join(userDataDir, "SingletonLock");
  try {
    lstatSync(lock); // throws if the symlink isn't there
  } catch {
    return false;
  }
  try {
    const pid = parseInt(readlinkSync(lock).split("-").pop() || "", 10);
    if (pid > 0) {
      try { process.kill(pid, 0); return true; } // signal 0 = liveness probe
      catch { return false; } // stale lock, owning process is gone
    }
  } catch { /* couldn't parse — fall through to "assume locked" */ }
  return true; // lock present but unverifiable: safer to treat as in use
}

/**
 * Detect whether a Chrome/Edge instance is already using the given user-data
 * directory. If so, attach mode must refuse to launch — Chrome would merge into
 * the existing instance and never expose our CDP port. We check the profile's
 * SingletonLock first (authoritative + profile-specific), then fall back to a
 * broad, CASE-INSENSITIVE process scan (the old lowercase `chrome` pattern
 * missed macOS's "Google Chrome Helper" processes that linger after the window
 * closes — the bug that let attach proceed onto a locked profile).
 */
export async function isChromeRunningOnProfile(userDataDir: string): Promise<boolean> {
  if (isProfileLocked(userDataDir)) {
    logger.info("[browser] real Chrome profile is locked (SingletonLock) — in use");
    return true;
  }
  try {
    const { execSync } = await import("node:child_process");
    const isWin = process.platform === "win32";
    if (isWin) {
      const out = execSync(`tasklist /FI "IMAGENAME eq chrome.exe" /NH`, { encoding: "utf8", timeout: 3000 }).toString();
      if (/chrome\.exe/i.test(out)) return true;
      const edgeOut = execSync(`tasklist /FI "IMAGENAME eq msedge.exe" /NH`, { encoding: "utf8", timeout: 3000 }).toString();
      if (userDataDir.toLowerCase().includes("edge") && /msedge\.exe/i.test(edgeOut)) return true;
      return false;
    }
    // POSIX: scan full command lines for the user's MAIN browser binary. The old
    // broad `chrome` match was unreliable both ways — it false-POSITIVED on
    // Electron apps that ship a `chrome_crashpad_handler` (VS Code, Slack), and
    // its lowercase pattern false-NEGATIVED on macOS's "Google Chrome" path. We
    // now match only the actual browser executable, exclude our OWN agent Chrome
    // (it always carries --remote-debugging-port), and ignore helper/crashpad
    // processes (their paths are under .../Frameworks/... or end in _handler).
    const out = execSync(`ps -axo command= 2>/dev/null || true`, { encoding: "utf8", timeout: 3000 }).toString();
    const mainBrowser = process.platform === "darwin"
      ? /\/(Google Chrome|Microsoft Edge|Chromium)\.app\/Contents\/MacOS\/(Google Chrome|Microsoft Edge|Chromium)(\s|$)/
      : /(^|\/)(google-chrome|google-chrome-stable|chromium|chromium-browser|microsoft-edge)(\s|$)/;
    const running = out.split("\n").some(
      (line) => mainBrowser.test(line) && !/--remote-debugging-port/.test(line),
    );
    if (running) logger.info("[browser] user's Chrome browser process detected — profile in use");
    return running;
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
  const cfg = getRuntimeConfig();
  const mode = cfg.browserMode || "isolated";
  let chromeProcess: ChildProcess | null = null;
  // Carried to the attach error so it can distinguish the two failure modes:
  // handoff (Chrome was already running) vs. the spawned Chrome staying alive
  // but never opening CDP (Chrome 136+ ignores --remote-debugging-port on the
  // real/default profile — an anti-cookie-theft block that can't be worked
  // around). Without this we'd blame "Chrome is still running" for a launch
  // that Chrome itself silently refused.
  let attachHandedOff = false;

  if (chromePath) {
    // Mode-specific CDP port. Isolated and attach are different profiles, so
    // they must never share a debugging port — otherwise a stale isolated
    // Chrome left listening on the base port from a previous run gets
    // reconnected when the user switches to attach, silently serving the agent
    // its own empty profile instead of the user's real one. +1 keeps them apart.
    const cdpPort = cfg.browserCdpPort + (mode === "attach" ? 1 : 0);

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
          "Can't use your real browser yet — Google Chrome is still running. " +
          "Closing the window isn't enough: Chrome keeps a background process that holds your " +
          "profile. Quit it completely (⌘Q, or right-click the Dock icon → Quit), then retry. " +
          "Or switch back to isolated mode in Settings → Security."
        );
      }
      userDataDir = real;
      logger.info(`[browser] Attach mode — using your real Chrome profile: ${userDataDir}`);
    } else {
      userDataDir = join(getLaxDir(), "chrome-profile");
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

    // Spawn a fully separate Chrome process. The distinct --user-data-dir plus
    // --remote-debugging-port keep this off the user's main instance. All
    // feature-disables are consolidated into one --disable-features flag
    // (Chrome honors only the last occurrence), and --download.default_directory
    // points downloads at workspace/downloads/.
    const downloadsDir = resolveDownloadsDir();
    // In attach mode keep Chrome's normal OS keychain backend so it can decrypt
    // the user's existing saved passwords/cookies — `--password-store=basic`
    // forces an empty store and would leave them locked out. (Harmless to keep
    // for the isolated profile, which has nothing encrypted, but only attach
    // needs the real keychain.)
    const stealthArgs = mode === "attach"
      ? STEALTH_ARGS.filter((a) => a !== "--password-store=basic")
      : STEALTH_ARGS;
    const args = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      ...stealthArgs,
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

    // Handoff detector. When Chrome is already running on this profile, the new
    // invocation forwards its request to the existing instance and the process
    // we spawned exits almost immediately — it never opens our debug port. Catch
    // that exit so we fail in ~1s with a precise "Chrome still running" message
    // instead of polling the full 9s, and so attach detection that slipped past
    // the pre-launch check still resolves to the right error.
    chromeProcess.once("exit", () => { attachHandedOff = true; });

    // Wait up to ~9s for CDP to come up (or bail early on handoff).
    let ready = false;
    for (let i = 0; i < 30; i++) {
      if (attachHandedOff) {
        logger.info("[browser] spawned Chrome exited immediately — handed off to a running instance");
        break;
      }
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

  // Attach mode must NEVER fall through to the persistent-context fallback:
  // that launches a fresh EMPTY profile (chrome-profile-pw), so the user thinks
  // they're driving their real browser with all their logins when they're
  // actually on a blank, signed-out profile. If we got here in attach mode the
  // real Chrome couldn't be driven (almost always: it's still running and holds
  // the profile lock). Fail loudly with the fix instead of silently lying.
  if (mode === "attach") {
    if (attachHandedOff) {
      // The spawned Chrome exited immediately → it forwarded to an instance
      // already holding the profile. Quitting Chrome fully will clear this.
      throw new Error(
        "Couldn't attach: Chrome is still running and holds your profile. Quit it completely " +
        "(⌘Q, or right-click the Dock icon → Quit) and retry, or switch to isolated mode in " +
        "Settings → Security."
      );
    }
    // The spawned Chrome stayed alive but never opened the debug port. On
    // Chrome 136+ this is by design: Chrome ignores --remote-debugging-port when
    // it points at your real/default profile, to stop programs from driving your
    // logged-in browser. There is no flag that re-enables it — the only ways to
    // use your real logins are a separate copied profile or a browser extension.
    throw new Error(
      "Your Chrome can't be remote-controlled on your real profile. Since Chrome 136 (you're on " +
      "148) Chrome refuses remote debugging on your real/default profile as an anti-malware " +
      "measure — this can't be worked around with a flag. Use isolated mode and sign in once " +
      "there (the agent browser keeps you logged in afterward), or ask to enable a \"copy my " +
      "logins\" profile mode."
    );
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
