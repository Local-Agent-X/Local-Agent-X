import { BrowserWindow, shell } from "electron";
import type { ChildProcess } from "child_process";

import {
  handleBrowserBridgeMessage,
  isBrowserBridgeMessage,
  wireBrowserEgressEvaluator,
} from "./server-bridge-browser";
import { captureScreenInMain } from "./screen-capture-native";
import { handleAndroidFrameMessage } from "./android-view";
import { isLoopbackAppUrl } from "./contract/loopback-app-url.js";
import { isServerToMainMessage, type MainToServerMessage, type ProbeAppError, type ProbeAppReply, type ProbeAppRequest } from "./contract/ipc.js";

// Fulfills native-capability requests from the server child over the IPC
// channel using Electron main-only APIs:
//   - trashItem: server-side deletes land in the OS Trash / Recycle Bin with
//     Put Back (macOS) / Restore (Windows, Linux) — a raw move into ~/.Trash
//     records neither.
//   - restart-server / relaunch-app: lets the agent self-restart over messaging
//     (the `restart` / `apply_update` tools). The actions are injected as
//     handlers so this module doesn't import server-process (which imports us).
//   - probe-app: loads a built app in an invisible BrowserWindow and reports
//     runtime evidence (console errors, failed loads, blankness, optional
//     screenshot) so the server can verify a build actually renders.
//   - lax:browser-*: drives the in-app browser view pool (lifecycle, navigate,
//     exec, input, capture, abort) — dispatched to server-bridge-browser.ts,
//     which also wires the partition egress guard to ask the server for its
//     canonical URL policy per hop.

type ProbeOutcome = Omit<ProbeAppReply, "type" | "id">;

const PROBE_DEFAULT_TIMEOUT_MS = 8_000;
const PROBE_SETTLE_MS = 1_200;                    // post-load wait so async JS errors land
const PROBE_MAX_SCREENSHOT_B64 = 2 * 1024 * 1024; // oversized screenshots are dropped, not truncated

export interface ServerBridgeHandlers {
  /** Restart the server child (picks up new src/dist). */
  onRestartServer: () => void;
  /** Relaunch the whole Electron app (picks up desktop/ changes too). */
  onRelaunchApp: () => void;
}

export function attachServerBridge(proc: ChildProcess, handlers: ServerBridgeHandlers): void {
  // Browser-view partitions have no egress policy of their own — every hop
  // asks this child (fail-closed on timeout / dead child). Re-wired on each
  // (re)spawn so the evaluator always targets the live process.
  wireBrowserEgressEvaluator(proc);
  const reply = (message: MainToServerMessage): void => {
    try { proc.send?.(message); } catch { /* child exited */ }
  };
  proc.on("message", async (msg: unknown) => {
    if (isBrowserBridgeMessage(msg as { type?: unknown })) {
      await handleBrowserBridgeMessage(proc, msg as Parameters<typeof handleBrowserBridgeMessage>[1]);
      return;
    }
    if (!isServerToMainMessage(msg)) return;
    switch (msg.type) {
      case "lax:android-frame":
        handleAndroidFrameMessage(msg);
        return;
      case "lax:trash-item": {
        let ok = false;
        try { await shell.trashItem(msg.path); ok = true; } catch { ok = false; }
        reply({ type: "lax:trash-item-result", id: msg.id, ok });
        return;
      }
      case "lax:probe-app":
        reply({ type: "lax:probe-app-result", id: msg.id, ...(await probeApp(msg)) }); // probeApp never throws
        return;
      case "lax:capture-screen":
        // Capture in MAIN, which holds the macOS Screen Recording grant the
        // standalone-node server child doesn't. captureScreenInMain never throws.
        reply({ type: "lax:capture-screen-result", id: msg.id, ...(await captureScreenInMain(msg)) });
        return;
      case "lax:restart-server":
        console.log("[desktop] server child requested a restart");
        try { handlers.onRestartServer(); } catch (e) { console.error("[desktop] restart handler failed", e); }
        return;
      case "lax:relaunch-app":
        console.log("[desktop] server child requested a full app relaunch");
        try { handlers.onRelaunchApp(); } catch (e) { console.error("[desktop] relaunch handler failed", e); }
        return;
    }
  });
}

// Load the app in a hidden, sandboxed window and collect runtime evidence.
// The window is never shown or focused and is ALWAYS destroyed. Never throws —
// internal failures come back as { ok: false, error } so a probe can't take
// down the bridge listener. The loopback check is the contract's
// (contract/loopback-app-url.ts): main is the actual loadURL sink and must
// never trust the child's URL blindly.
async function probeApp(req: ProbeAppRequest): Promise<ProbeOutcome> {
  const errors: ProbeAppError[] = [];
  let win: BrowserWindow | null = null;
  try {
    if (!isLoopbackAppUrl(req.url)) {
      return { ok: false, booted: false, errors: [], error: `refused non-loopback URL: ${req.url}` };
    }
    win = new BrowserWindow({
      show: false,
      // backgroundThrottling off: hidden renderers throttle timers, which would
      // keep async errors from landing inside the settle window.
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    const wc = win.webContents;
    const timeoutMs = req.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS;

    // Boot settles on did-finish-load (true) or main-frame failure / renderer
    // death / deadline (false). Collectors stay attached through the settle
    // window so late failures are still recorded.
    let settleBoot: ((ok: boolean) => void) | null = null;
    wc.on("console-message", (details) => {
      if (details.level !== "error") return;
      errors.push({ kind: "console", message: details.message, source: details.sourceId || undefined, line: details.lineNumber });
    });
    wc.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (errorCode === -3) return; // navigation aborted (e.g. JS redirect) — not a failure
      errors.push({ kind: "resource", message: `${errorDescription} (${validatedURL})` });
      if (isMainFrame) settleBoot?.(false);
    });
    wc.on("render-process-gone", (_e, details) => {
      errors.push({ kind: "error", message: `renderer process gone (${details.reason})` });
      settleBoot?.(false);
    });

    const booted = await new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => {
        errors.push({ kind: "blank", message: `page did not finish loading within ${Math.round(timeoutMs / 1000)}s` });
        settleBoot?.(false);
      }, timeoutMs);
      settleBoot = (ok: boolean) => { settleBoot = null; clearTimeout(deadline); resolve(ok); };
      wc.once("did-finish-load", () => settleBoot?.(true));
      wc.loadURL(req.url).catch((e) => {
        if (!settleBoot) return; // did-fail-load already recorded + settled it
        errors.push({ kind: "resource", message: e instanceof Error ? e.message : String(e) });
        settleBoot(false);
      });
    });

    let screenshotB64: string | undefined;
    if (booted && !wc.isDestroyed()) {
      await new Promise((r) => setTimeout(r, PROBE_SETTLE_MS));
      try {
        const stats = await wc.executeJavaScript(
          "({ textLen: document.body ? document.body.innerText.trim().length : 0, els: document.body ? document.body.querySelectorAll('*').length : 0, hasVisual: !!(document.body && document.body.querySelector('canvas,svg,img,video')) })",
        ) as { textLen: number; els: number; hasVisual: boolean };
        // A canvas/WebGL/SVG app renders no text and few DOM nodes but is NOT
        // blank — so a rendered visual element vetoes the empty verdict.
        if (stats.textLen === 0 && stats.els < 3 && !stats.hasVisual) {
          errors.push({ kind: "blank", message: "page rendered empty (no visible text or elements)" });
        }
      } catch { /* renderer died mid-probe; render-process-gone recorded it */ }
      if (req.wantScreenshot && !wc.isDestroyed()) {
        try {
          const b64 = (await wc.capturePage()).toPNG().toString("base64");
          if (b64.length <= PROBE_MAX_SCREENSHOT_B64) screenshotB64 = b64;
        } catch { /* screenshot is best-effort evidence */ }
      }
    }
    return { ok: true, booted, errors, screenshotB64 };
  } catch (e) {
    return { ok: false, booted: false, errors, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
  }
}
