// Bridge from the server child process to the Electron main process for native
// OS capabilities the child can't perform itself:
//   - trashItem — main calls shell.trashItem so deletes land in the real OS
//     Trash / Recycle Bin with Put Back (macOS) / Restore (Windows, Linux),
//     which a raw filesystem move into ~/.Trash can't record.
//   - probeApp — main loads a built app in an invisible BrowserWindow and
//     returns runtime evidence (console errors, failed loads, blankness,
//     optional screenshot) for the render-verify gate.
//
// Transport is the parent-child IPC channel (process.send), present only when
// the desktop spawns us with stdio 'ipc' and sets LAX_DESKTOP_BRIDGE=1. Outside
// the desktop app (standalone server, tests, headless) the bridge is absent and
// callers fall back to their own filesystem path. The env gate keeps us from
// mistaking an unrelated IPC parent (e.g. a vitest fork) for the desktop.

import { createLogger } from "./logger.js";
import { DESKTOP_ENV } from "./desktop-contract/env.js";
import { isLoopbackAppUrl } from "./desktop-contract/loopback-app-url.js";
import {
  isMainToServerMessage,
  type CaptureScreenReply, type CaptureScreenRequest, type ProbeAppError, type ProbeAppReply, type ServerToMainMessage,
} from "./desktop-contract/ipc.js";

export { isLoopbackAppUrl };
export type { ProbeAppError };

const logger = createLogger("desktop-bridge");
const REPLY_TIMEOUT_MS = 5_000;
// A full-resolution desktopCapturer.getSources on a 5K display can take a
// second or two; give the round-trip more headroom than a trashItem.
const CAPTURE_REPLY_TIMEOUT_MS = 8_000;
const PROBE_DEFAULT_TIMEOUT_MS = 8_000;
// Main keeps working after its load deadline (settle wait, blank check,
// screenshot), so the IPC reply is allowed that much extra before we give up.
const PROBE_REPLY_GRACE_MS = 5_000;

/** Runtime evidence from probing a built app in an invisible desktop window. */
export type ProbeAppResult = Pick<ProbeAppReply, "booted" | "errors" | "screenshotB64">;

/** A screenshot captured by Electron main on the server's behalf. */
export interface CaptureScreenResult { image: Buffer; format: "png" | "jpg"; width: number; height: number; }

let seq = 0;
const pending = new Map<number, (ok: boolean) => void>();
const pendingProbes = new Map<number, (reply: ProbeAppReply) => void>();
const pendingCaptures = new Map<number, (reply: CaptureScreenReply) => void>();
let listenerAttached = false;
let panicHandler: (() => void) | null = null;

export function desktopBridgeAvailable(): boolean {
  return process.env[DESKTOP_ENV.BRIDGE] === "1" && typeof process.send === "function";
}

function send(message: ServerToMainMessage): void {
  process.send!(message);
}

// Single inbound listener for every main→server message: trashItem/probeApp
// replies (request/reply) and the panic kill-switch (fire-and-forget). Attached
// lazily by the first consumer, so non-desktop runs never add a no-op listener.
function ensureListener(): void {
  if (listenerAttached) return;
  listenerAttached = true;
  process.on("message", (msg: unknown) => {
    if (!isMainToServerMessage(msg)) return;
    switch (msg.type) {
      case "lax:trash-item-result":
        pending.get(msg.id)?.(!!msg.ok);
        return;
      case "lax:probe-app-result":
        pendingProbes.get(msg.id)?.({ ...msg, ok: !!msg.ok, booted: !!msg.booted, errors: Array.isArray(msg.errors) ? msg.errors : [] });
        return;
      case "lax:capture-screen-result":
        pendingCaptures.get(msg.id)?.(msg);
        return;
      case "lax:panic-abort":
        try { panicHandler?.(); }
        catch (e) { logger.warn(`[bridge] panic handler failed: ${(e as Error).message}`); }
        return;
    }
  });
}

/** Register the server-side handler for the desktop PANIC hotkey. Electron main
 *  sends `lax:panic-abort` when the user hits the kill switch; the handler
 *  aborts every in-flight run and disarms computer control. Wired once at boot
 *  (server/index.ts); attaching the listener here means panic works even before
 *  any trashItem request this session. */
export function registerDesktopPanicHandler(handler: () => void): void {
  panicHandler = handler;
  ensureListener();
}

/** Ask Electron main to move `path` to the OS Trash / Recycle Bin via
 *  shell.trashItem (records the original location for Put Back / Restore).
 *  Resolves false if the bridge is absent, errors, or doesn't reply in time —
 *  the caller then falls back to its own filesystem trash. */
export function desktopTrashItem(path: string): Promise<boolean> {
  if (!desktopBridgeAvailable()) return Promise.resolve(false);
  ensureListener();
  const id = ++seq;
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (ok: boolean) => { clearTimeout(timer); pending.delete(id); resolve(ok); };
    pending.set(id, finish);
    timer = setTimeout(() => { logger.warn(`[bridge] trashItem timed out for ${path}`); finish(false); }, REPLY_TIMEOUT_MS);
    try {
      send({ type: "lax:trash-item", id, path });
    } catch (e) {
      logger.warn(`[bridge] trashItem send failed: ${(e as Error).message}`);
      finish(false);
    }
  });
}

/** Ask Electron main to load `url` in an invisible BrowserWindow and report
 *  runtime evidence (console errors, failed loads, blankness, optional
 *  screenshot). INVARIANT: the probe loads only local app URLs
 *  (desktop-contract/loopback-app-url.ts, checked again by main). Resolves null
 *  if the bridge is absent (headless), the URL is non-local, main reports an
 *  internal failure, or the reply misses the deadline plus grace — callers treat
 *  null as "no evidence", never as "verified". */
export function probeApp(url: string, opts?: { timeoutMs?: number; wantScreenshot?: boolean }): Promise<ProbeAppResult | null> {
  if (!desktopBridgeAvailable()) return Promise.resolve(null);
  if (!isLoopbackAppUrl(url)) {
    logger.warn(`[bridge] probeApp rejected non-loopback URL: ${url}`);
    return Promise.resolve(null);
  }
  ensureListener();
  const id = ++seq;
  const timeoutMs = opts?.timeoutMs ?? PROBE_DEFAULT_TIMEOUT_MS;
  return new Promise<ProbeAppResult | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: ProbeAppResult | null) => { clearTimeout(timer); pendingProbes.delete(id); resolve(result); };
    pendingProbes.set(id, (reply) => {
      if (!reply.ok) { logger.warn(`[bridge] probeApp failed in main: ${reply.error ?? "unknown"}`); finish(null); return; }
      finish({ booted: reply.booted, errors: reply.errors, screenshotB64: reply.screenshotB64 });
    });
    timer = setTimeout(() => { logger.warn(`[bridge] probeApp timed out for ${url}`); finish(null); }, timeoutMs + PROBE_REPLY_GRACE_MS);
    try {
      send({ type: "lax:probe-app", id, url, timeoutMs, wantScreenshot: opts?.wantScreenshot });
    } catch (e) {
      logger.warn(`[bridge] probeApp send failed: ${(e as Error).message}`);
      finish(null);
    }
  });
}

/** Ask Electron main to capture the screen and return the image. WHY this
 *  exists: the desktop app runs the server as a standalone Node binary spawned
 *  OUTSIDE the .app bundle (native-addon ABI, see desktop/src/server-process.ts).
 *  macOS ties the Screen Recording TCC grant to the .app, NOT to that Node
 *  runtime, so a `screencapture` the server spawns itself is denied even when
 *  "Local Agent X" is toggled on. Electron main IS the granted .app, so it
 *  captures successfully and hands the bytes back over IPC. Resolves null when
 *  the bridge is absent (headless / non-desktop) or main reports a failure —
 *  the caller then falls back to the in-process CLI path (which yields the
 *  accurate TCC-denied message). */
export function desktopCaptureScreen(opts: Omit<CaptureScreenRequest, "type" | "id">): Promise<CaptureScreenResult | null> {
  if (!desktopBridgeAvailable()) return Promise.resolve(null);
  ensureListener();
  const id = ++seq;
  return new Promise<CaptureScreenResult | null>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: CaptureScreenResult | null) => { clearTimeout(timer); pendingCaptures.delete(id); resolve(result); };
    pendingCaptures.set(id, (reply) => {
      if (!reply.ok || !reply.imageB64) { logger.warn(`[bridge] capture-screen failed in main: ${reply.error ?? "unknown"}`); finish(null); return; }
      finish({
        image: Buffer.from(reply.imageB64, "base64"),
        format: reply.format === "png" ? "png" : "jpg",
        width: reply.width ?? 0,
        height: reply.height ?? 0,
      });
    });
    timer = setTimeout(() => { logger.warn("[bridge] capture-screen timed out"); finish(null); }, CAPTURE_REPLY_TIMEOUT_MS);
    try {
      send({ type: "lax:capture-screen", id, monitor: opts.monitor, region: opts.region, format: opts.format, quality: opts.quality, scale: opts.scale });
    } catch (e) {
      logger.warn(`[bridge] capture-screen send failed: ${(e as Error).message}`);
      finish(null);
    }
  });
}

/** Fire-and-forget: ask Electron main to restart the SERVER CHILD (picks up new
 *  src/dist code; serverDistIsFresh falls back to tsx when source is newer).
 *  No reply — the server is about to be killed. Returns false when the desktop
 *  bridge is absent (headless / npm run dev) so the caller can't self-restart. */
export function desktopRestartServer(): boolean {
  if (!desktopBridgeAvailable()) return false;
  try { send({ type: "lax:restart-server" }); return true; }
  catch (e) { logger.warn(`[bridge] restart-server send failed: ${(e as Error).message}`); return false; }
}

/** Fire-and-forget: ask Electron main to relaunch the WHOLE app. Needed after a
 *  platform update, which can include desktop/ (Electron-main) changes a server-
 *  child restart can't reload. */
export function desktopRelaunchApp(): boolean {
  if (!desktopBridgeAvailable()) return false;
  try { send({ type: "lax:relaunch-app" }); return true; }
  catch (e) { logger.warn(`[bridge] relaunch-app send failed: ${(e as Error).message}`); return false; }
}

/** Fire-and-forget: push one Android device frame to Electron main
 *  (desktop/src/android-view.ts), which relays it to the renderer canvas
 *  sink. No reply — src/android/frame-stream.ts calls this every polled
 *  frame and drops it silently outside the desktop app (headless/dev), same
 *  as the other one-way pushes above. */
export function desktopPushAndroidFrame(viewId: string, png: Buffer): boolean {
  if (!desktopBridgeAvailable()) return false;
  try { send({ type: "lax:android-frame", viewId, pngBase64: png.toString("base64") }); return true; }
  catch (e) { logger.warn(`[bridge] android-frame send failed: ${(e as Error).message}`); return false; }
}
