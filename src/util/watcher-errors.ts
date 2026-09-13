/**
 * The listener every fs.watch caller owes its watcher.
 *
 * watch() throws only for failures it can see while the watcher is being
 * created — a missing path, a bad option. Everything that goes wrong after
 * that arrives as an 'error' EVENT: the watched directory deleted, renamed, or
 * made unreadable, which on Windows surfaces as EPERM. An EventEmitter that
 * emits 'error' with no listener rethrows it as an uncaught exception, so a
 * `try { watch(...) } catch {}` reads like it covers the failure and covers
 * none of it — the process is still one deleted directory from dying. CI saw
 * exactly this: nine uncaught `EPERM: operation not permitted, watch`.
 *
 * A watcher that has errored is dead, so close it rather than leaving a handle
 * that can emit again.
 */
import type { FSWatcher } from "node:fs";
import { createLogger } from "../logger.js";

const logger = createLogger("util.watcher");

export function handleWatcherErrors(watcher: FSWatcher, source: string): FSWatcher {
  watcher.on("error", (error: Error) => {
    logger.warn(`[${source}] watcher stopped: ${error.message}`);
    try { watcher.close(); } catch { /* already torn down by the failure */ }
  });
  return watcher;
}
