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

interface TrashResult { type: "lax:trash-item-result"; id: number; ok: boolean; }

let seq = 0;
const pending = new Map<number, (ok: boolean) => void>();
let listenerAttached = false;

export function desktopBridgeAvailable(): boolean {
  return process.env.LAX_DESKTOP_BRIDGE === "1" && typeof process.send === "function";
}

function ensureListener(): void {
  if (listenerAttached) return;
  listenerAttached = true;
  process.on("message", (msg: TrashResult) => {
    if (!msg || msg.type !== "lax:trash-item-result") return;
    const fn = pending.get(msg.id);
    if (fn) fn(msg.ok);
  });
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
