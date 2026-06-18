// Bridge from the server child process to the Electron main process for native
// OS capabilities the child can't perform itself. Currently one method:
// trashItem — main calls shell.trashItem so deletes land in the real OS Trash /
// Recycle Bin with Put Back (macOS) / Restore (Windows, Linux), which a raw
// filesystem move into ~/.Trash can't record.
//
// Transport is the parent-child IPC channel (process.send), present only when
// the desktop spawns us with stdio 'ipc' and sets LAX_DESKTOP_BRIDGE=1. Outside
// the desktop app (standalone server, tests, headless) the bridge is absent and
// callers fall back to their own filesystem path. The env gate keeps us from
// mistaking an unrelated IPC parent (e.g. a vitest fork) for the desktop.

import { createLogger } from "./logger.js";

const logger = createLogger("desktop-bridge");
const REPLY_TIMEOUT_MS = 5_000;

let seq = 0;
const pending = new Map<number, (ok: boolean) => void>();
let listenerAttached = false;
let panicHandler: (() => void) | null = null;

export function desktopBridgeAvailable(): boolean {
  return process.env.LAX_DESKTOP_BRIDGE === "1" && typeof process.send === "function";
}

// Single inbound listener for every main→server message: trashItem replies
// (request/reply) and the panic kill-switch (fire-and-forget). Attached lazily
// by the first consumer, so non-desktop runs never add a no-op listener.
function ensureListener(): void {
  if (listenerAttached) return;
  listenerAttached = true;
  process.on("message", (msg: { type?: string; id?: number; ok?: boolean }) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "lax:trash-item-result") {
      const fn = pending.get(msg.id!);
      if (fn) fn(!!msg.ok);
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
