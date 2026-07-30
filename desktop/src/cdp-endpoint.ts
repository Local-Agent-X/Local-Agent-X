/**
 * Loopback CDP endpoint for the in-app browser driver.
 *
 * The embedded browser (WebContentsView) is Chromium, but today it can only be
 * driven through low-fidelity primitives (executeJavaScriptInIsolatedWorld +
 * sendInputEvent). To drive it the way the external agent-Chrome is driven —
 * Playwright over CDP, with frame-aware locators and trusted input — the
 * server process needs a DevTools endpoint to connect to.
 *
 * Security posture (deliberate, and narrow):
 *   - Bound to 127.0.0.1 ONLY (remote-debugging-address). Chromium binds the
 *     DevTools protocol to loopback, so no other host can reach it.
 *   - Chromium chooses a fresh EPHEMERAL port (we pass port 0, never a fixed,
 *     guessable port) and records it in the user-data-dir's DevToolsActivePort
 *     file. We read that and hand it only to our own server child via an env
 *     var — never written elsewhere or logged.
 * DevTools-over-loopback is still a local-process capability — any process
 * already running as this user could attach — so this is exactly as privileged
 * as the code the app already runs, and no more. It exists solely to let the
 * first-party server drive the first-party agent browser.
 *
 * The switch MUST be appended before app.ready (Chromium reads its command
 * line only at startup), so we cannot bind-and-pick a port ourselves (async).
 * Port 0 keeps enable() fully synchronous and race-free; discovery happens
 * later, once Chromium has written DevToolsActivePort.
 */
import { app } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

let chosenPort: number | null = null;
// Whether the switches were actually appended this launch. The endpoint is
// opt-in (config.browserNativeDriving — see chromium-flags.ts), so this is
// false on a normal launch, and resolve MUST NOT read a DevToolsActivePort file
// left behind by an earlier enabled run: that port is dead, and handing it to
// the server child would point the driver at nothing.
let endpointEnabled = false;

/**
 * Append the loopback CDP switches. MUST run before app.ready. Synchronous and
 * infallible — the actual port is chosen by Chromium and resolved later.
 */
export function enableLoopbackCdpEndpoint(): void {
  endpointEnabled = true;
  app.commandLine.appendSwitch("remote-debugging-port", "0");
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
}

/** Parse a DevToolsActivePort file. Its first line is the chosen port; the
 *  optional second line is the browser websocket path. Returns null on any
 *  malformed / out-of-range content. Pure — the unit-tested core. */
export function parseDevToolsActivePort(contents: string): number | null {
  const first = contents.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!/^\d+$/.test(first)) return null;
  const port = Number(first);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Resolve the port Chromium chose by polling <userDataDir>/DevToolsActivePort
 * (written during Chromium init, so it may lag app.ready by a few ms). Caches
 * the result for getLoopbackCdpPort(). Returns null if it never appears within
 * the timeout — the in-app driver then stays on the legacy bridge path.
 * `userDataDir` is injectable for tests; production reads app.getPath.
 */
export async function resolveLoopbackCdpPort(opts?: {
  userDataDir?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<number | null> {
  if (!endpointEnabled) {
    chosenPort = null;
    return null;
  }
  const userDataDir = opts?.userDataDir ?? app.getPath("userData");
  const timeoutMs = opts?.timeoutMs ?? 3000;
  const pollMs = opts?.pollMs ?? 50;
  const file = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const port = parseDevToolsActivePort(await readFile(file, "utf-8"));
      if (port !== null) {
        chosenPort = port;
        return port;
      }
    } catch {
      // not written yet — fall through to the wait/retry below
    }
    if (Date.now() >= deadline) {
      chosenPort = null;
      return null;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** The resolved CDP port, or null if not enabled / not yet resolved. */
export function getLoopbackCdpPort(): number | null {
  return chosenPort;
}

/** Test seam: simulate the opt-in having been applied (or not) at launch,
 *  without an Electron app.commandLine. */
export function _setEndpointEnabledForTest(enabled: boolean): void {
  endpointEnabled = enabled;
  chosenPort = null;
}
