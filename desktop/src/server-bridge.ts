import { BrowserWindow, shell } from "electron";
import type { ChildProcess } from "child_process";

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

interface TrashRequest { type: "lax:trash-item"; id: number; path: string; }
interface RestartRequest { type: "lax:restart-server" }
interface RelaunchRequest { type: "lax:relaunch-app" }
interface ProbeRequest { type: "lax:probe-app"; id: number; url: string; timeoutMs?: number; wantScreenshot?: boolean }
type ServerMessage = TrashRequest | RestartRequest | RelaunchRequest | ProbeRequest;

interface ProbeError { kind: string; message: string; source?: string; line?: number }
interface ProbeOutcome { ok: boolean; booted: boolean; errors: ProbeError[]; screenshotB64?: string; error?: string }

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
  proc.on("message", async (msg: ServerMessage) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "lax:trash-item") {
      let ok = false;
      try { await shell.trashItem(msg.path); ok = true; } catch { ok = false; }
      try { proc.send?.({ type: "lax:trash-item-result", id: msg.id, ok }); } catch { /* child exited */ }
      return;
    }
    if (msg.type === "lax:probe-app") {
      const result = await probeApp(msg); // never throws
      try { proc.send?.({ type: "lax:probe-app-result", id: msg.id, ...result }); } catch { /* child exited */ }
      return;
    }
    if (msg.type === "lax:restart-server") {
      console.log("[desktop] server child requested a restart");
      try { handlers.onRestartServer(); } catch (e) { console.error("[desktop] restart handler failed", e); }
      return;
    }
    if (msg.type === "lax:relaunch-app") {
      console.log("[desktop] server child requested a full app relaunch");
      try { handlers.onRelaunchApp(); } catch (e) { console.error("[desktop] relaunch handler failed", e); }
      return;
    }
  });
}

// Loopback-host guard, mirrored from the server-side sender (src/desktop-bridge
// isLoopbackAppUrl) as defense in depth: main is the actual loadURL sink and
// must never trust the child's URL blindly. Host grammar, not a string prefix —
// `http://127.0.0.1:80@evil.com/` has host evil.com (the 127.0.0.1 is userinfo).
function isLoopbackAppUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost";
}

// Load the app in a hidden, sandboxed window and collect runtime evidence.
// The window is never shown or focused and is ALWAYS destroyed. Never throws —
// internal failures come back as { ok: false, error } so a probe can't take
// down the bridge listener.
async function probeApp(req: ProbeRequest): Promise<ProbeOutcome> {
  const errors: ProbeError[] = [];
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
