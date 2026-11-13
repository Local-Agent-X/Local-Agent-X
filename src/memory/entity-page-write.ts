/**
 * Writing an entity page (bank/entities/<slug>.md). The page is a view of the
 * Facts DB, rebuilt from it in full each time; the DB row is the record.
 *
 * The page is swapped into place with atomicWriteFileSync. On Windows the swap
 * is refused while any handle has the page open, and the commonest holder is
 * this process: each save re-indexes the page with an async read, and the next
 * save about the same entity (dream saves several facts about the user within
 * a second) arrives while that read is in flight. The write's own contention
 * retry waits synchronously, which blocks the event loop the read needs to
 * close its handle, so that retry cannot succeed. The fact had already landed,
 * yet the save threw and the side-effect journal reported an unknown outcome
 * (2026-11-12: about 70 refusals since late October, 64 of them on peter.md).
 *
 * So a busy page is rebuilt later, from the DB as it is then, after a real
 * timer has let the reader finish, and the save that wrote it returns normally.
 * The write itself never blocks the thread waiting for the file: that wait
 * could not succeed and froze the server for its length on every busy page.
 */
import { createLogger } from "../logger.js";
import {
  ATOMIC_WRITE_WITHOUT_WAITING, atomicWriteFileSync, isFileContentionError, type AtomicWriteOperations,
} from "../util/json-store.js";

const logger = createLogger("memory.entity-page-write");

/** Waits before each later rebuild of a busy page. After the last one the page
 *  is left as it is until the next change to one of its facts rebuilds it. */
export const ENTITY_PAGE_RETRY_DELAYS_MS = [100, 500, 2_000, 10_000] as const;

interface PendingRebuild {
  attempt: number;
  rebuild: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingRebuild>();

/**
 * Write a page, or, when the file is busy, hand `rebuild` (which rebuilds the
 * page from the DB and writes it here again) to a later timer. Returns whether
 * the page was written now. Any other write failure throws, as before.
 */
export function writeEntityPage(
  path: string,
  content: string,
  rebuild: () => void,
  operations?: AtomicWriteOperations,
): boolean {
  try {
    atomicWriteFileSync(path, content, undefined, operations ?? ATOMIC_WRITE_WITHOUT_WAITING);
  } catch (error) {
    if (!isFileContentionError(error)) throw error;
    deferRebuild(path, rebuild, error as Error);
    return false;
  }
  // Written: an earlier rebuild still waiting for this page has nothing to add.
  const waiting = pending.get(path);
  if (waiting?.timer) clearTimeout(waiting.timer);
  pending.delete(path);
  return true;
}

function deferRebuild(path: string, rebuild: () => void, error: Error): void {
  const entry = pending.get(path) ?? { attempt: 0, rebuild };
  // One timer per page; it runs the newest rebuild, which reads the DB then.
  entry.rebuild = rebuild;
  if (entry.timer) return;
  const delay = ENTITY_PAGE_RETRY_DELAYS_MS[entry.attempt];
  if (delay === undefined) {
    pending.delete(path);
    logger.warn(`[memory] entity page still busy after ${ENTITY_PAGE_RETRY_DELAYS_MS.length} later tries, left until its facts next change: ${path} (${error.message})`);
    return;
  }
  entry.attempt += 1;
  entry.timer = setTimeout(() => runRebuild(path), delay);
  entry.timer.unref?.();
  pending.set(path, entry);
}

function runRebuild(path: string): void {
  const entry = pending.get(path);
  if (!entry) return;
  entry.timer = undefined;
  try {
    entry.rebuild();
  } catch (error) {
    pending.delete(path);
    logger.warn(`[memory] later rebuild of entity page ${path} failed: ${(error as Error).message}`);
  }
}

/** Test-only: pages waiting for a later rebuild. */
export function _pendingEntityPageRebuilds(): string[] {
  return [...pending.keys()];
}

/** Test-only: drop every waiting rebuild. */
export function _resetEntityPageRebuilds(): void {
  for (const entry of pending.values()) if (entry.timer) clearTimeout(entry.timer);
  pending.clear();
}
