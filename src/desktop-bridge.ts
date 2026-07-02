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

const logger = createLogger("desktop-bridge");
const REPLY_TIMEOUT_MS = 5_000;
const PROBE_DEFAULT_TIMEOUT_MS = 8_000;
// Main keeps working after its load deadline (settle wait, blank check,
// screenshot), so the IPC reply is allowed that much extra before we give up.
const PROBE_REPLY_GRACE_MS = 5_000;

/** One runtime finding from the probe window. `kind` maps onto the render-verify
 *  PreviewRuntimeError kinds: "console" | "resource" | "error" | "blank". */
export interface ProbeAppError { kind: string; message: string; source?: string; line?: number; }

/** Runtime evidence from probing a built app in an invisible desktop window. */
export interface ProbeAppResult {
  /** did-finish-load fired before the deadline. */
  booted: boolean;
  errors: ProbeAppError[];
  /** PNG; present only when requested and under main's size cap. */
  screenshotB64?: string;
}

// Inbound wire shape of lax:probe-app-result (ok/error are consumed here).
interface ProbeReply { ok: boolean; booted: boolean; errors: ProbeAppError[]; screenshotB64?: string; error?: string; }

let seq = 0;
const pending = new Map<number, (ok: boolean) => void>();
const pendingProbes = new Map<number, (reply: ProbeReply) => void>();
let listenerAttached = false;
let panicHandler: (() => void) | null = null;

export function desktopBridgeAvailable(): boolean {
  return process.env.LAX_DESKTOP_BRIDGE === "1" && typeof process.send === "function";
}

// Single inbound listener for every main→server message: trashItem/probeApp
// replies (request/reply) and the panic kill-switch (fire-and-forget). Attached
// lazily by the first consumer, so non-desktop runs never add a no-op listener.
function ensureListener(): void {
  if (listenerAttached) return;
  listenerAttached = true;
  process.on("message", (msg: { type?: string; id?: number; ok?: boolean; booted?: boolean; errors?: ProbeAppError[]; screenshotB64?: string; error?: string }) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "lax:trash-item-result") {
      const fn = pending.get(msg.id!);
      if (fn) fn(!!msg.ok);
      return;
    }
    if (msg.type === "lax:probe-app-result") {
      const fn = pendingProbes.get(msg.id!);
      if (fn) fn({ ok: !!msg.ok, booted: !!msg.booted, errors: Array.isArray(msg.errors) ? msg.errors : [], screenshotB64: msg.screenshotB64, error: msg.error });
      return;
    }
    if (msg.type === "lax:panic-abort") {
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
      process.send!({ type: "lax:trash-item", id, path });
    } catch (e) {
      logger.warn(`[bridge] trashItem send failed: ${(e as Error).message}`);
      finish(false);
    }
  });
}

/** True only for a plain-http URL whose HOST is a loopback address and which
 *  carries no userinfo. Parsed with the URL host grammar, not a string prefix:
 *  `http://127.0.0.1:80@evil.com/` has host `evil.com` (the `127.0.0.1` is
 *  userinfo), so a `startsWith("http://127.0.0.1")` test would wave it through
 *  and the probe would load — and screenshot — a remote origin. The invariant
 *  is "the resolved host is loopback", enforced at the one place that decides
 *  whether to send. */
export function isLoopbackAppUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:") return false;        // app serving is plain http on loopback
  if (u.username || u.password) return false;       // reject userinfo (the @-bypass)
  const host = u.hostname.toLowerCase();
  // Exactly the two hosts LAX serves apps on — a deliberately tight allowlist.
  return host === "127.0.0.1" || host === "localhost";
}

/** Ask Electron main to load `url` in an invisible BrowserWindow and report
 *  runtime evidence (console errors, failed loads, blankness, optional
 *  screenshot). INVARIANT: the probe loads only local app URLs — anything whose
 *  resolved host isn't 127.0.0.1/localhost/[::1] is rejected. Resolves null if
 *  the bridge is absent (headless), the URL is non-local, main reports an
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
      process.send!({ type: "lax:probe-app", id, url, timeoutMs, wantScreenshot: opts?.wantScreenshot });
    } catch (e) {
      logger.warn(`[bridge] probeApp send failed: ${(e as Error).message}`);
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
  try { process.send!({ type: "lax:restart-server" }); return true; }
  catch (e) { logger.warn(`[bridge] restart-server send failed: ${(e as Error).message}`); return false; }
}

/** Fire-and-forget: ask Electron main to relaunch the WHOLE app. Needed after a
 *  platform update, which can include desktop/ (Electron-main) changes a server-
 *  child restart can't reload. */
export function desktopRelaunchApp(): boolean {
  if (!desktopBridgeAvailable()) return false;
  try { process.send!({ type: "lax:relaunch-app" }); return true; }
  catch (e) { logger.warn(`[bridge] relaunch-app send failed: ${(e as Error).message}`); return false; }
}
