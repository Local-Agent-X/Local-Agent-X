/**
 * The operation.json file itself: how a record kept in one reaches the disk,
 * and what becomes of one whose bytes are no longer a record.
 *
 * Two kinds of record live under that name, an Op (op-store.ts) and
 * autopilot's Operation (autopilot/). Both are written here and nowhere else
 * (operation-record-file.test.ts scans for a second writer), so a reader never
 * sees half a record: a file that does not parse is not one being written, it
 * is one that was lost.
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../logger.js";
import { atomicWriteFileSync, type AtomicWriteOperations } from "../util/json-store.js";

const logger = createLogger("ops.operation-record");

/** Where an op's record is kept, given the op's folder. */
export function operationRecordPath(opFolder: string): string {
  return join(opFolder, "operation.json");
}

/**
 * The atomic write with its new bytes flushed to disk before the rename. The
 * rename can reach the disk before the data does: after a crash or power loss
 * the record is then all zero bytes, unreadable, and its op is gone from every
 * view (an operation.json of 12,369 NULs, 2026-11-18). Flushing first means a
 * crash leaves the old record or the new one.
 */
export const FLUSHED_RECORD_WRITE: AtomicWriteOperations = {
  write: (path, data, opts) => {
    const fd = openSync(path, "w", opts.mode ?? 0o600);
    try {
      writeFileSync(fd, data, { encoding: opts.encoding });
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  },
  rename: renameSync,
  unlink: (path) => rmSync(path, { force: true }),
};

/** Replace the record in `opFolder` with `json`, whole or not at all. Throws when it cannot. */
export function writeOperationRecord(
  opFolder: string,
  json: string,
  operations: AtomicWriteOperations = FLUSHED_RECORD_WRITE,
): void {
  atomicWriteFileSync(operationRecordPath(opFolder), json, { mode: 0o600 }, operations);
}

/**
 * How long a record must have sat unchanged before one that does not parse is
 * moved. Every writer in this build replaces the file in one step, but a second
 * server of an older build on the same data dir (it has happened) writes
 * autopilot's record in place, and that write is over in milliseconds.
 */
const AT_REST_MS = 60_000;

/**
 * The parsed record in `opFolder`, or undefined when there is none to give: no
 * file, a file that could not be opened this time, or one that does not parse.
 *
 * The last is not retried forever. A record at rest that does not parse will
 * not parse tomorrow, and every start and every scan of the store read it and
 * reported it again (the 12,369 NULs above: 49 warnings in one log). It is
 * moved aside under the same name with `.unreadable-<time>` added, said once,
 * and from then on the folder reads as one with no record. Nothing is deleted.
 */
export function readOperationRecord(opFolder: string, opId: string): unknown {
  const path = operationRecordPath(opFolder);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") logger.warn(`[op-store] failed to read op ${opId}: ${(e as Error).message}`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    setAsideOnceAtRest(path, opId, text, e as Error);
    return undefined;
  }
}

function setAsideOnceAtRest(path: string, opId: string, text: string, cause: Error): void {
  let stat;
  try { stat = statSync(path); } catch { return; } // another reader has just moved it
  if (Date.now() - stat.mtimeMs < AT_REST_MS) {
    logger.warn(`[op-store] failed to read op ${opId}: ${cause.message}`);
    return;
  }
  const what = /^\0+$/.test(text)
    ? `all ${stat.size} of its bytes are zero, a write the disk never received`
    : cause.message;
  const aside = `${path}.unreadable-${Date.now()}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // moved by another reader
    logger.warn(`[op-store] op ${opId} has a record that cannot be read (${what}) and could not be moved aside: ${(e as Error).message}`);
    return;
  }
  logger.warn(`[op-store] op ${opId} has a record that cannot be read (${what}), last written ${stat.mtime.toISOString()}. `
    + `Kept as ${aside}; the op no longer appears anywhere. This is said once.`);
}
