/**
 * Questions about the op store that must not read all of it.
 *
 * `listOps()` parses every op ever run. On the owner's machine that was 5,198
 * records and 449 MB of JSON: 1.9 s on the server's one thread and 840 MB of
 * heap held for the call, to answer "which ops belong to this chat" (14 of
 * them). The phone's view of a chat asked it on every load, and the server ran
 * out of memory in the middle of a build (2026-11-22).
 *
 * This keeps a few facts per op and re-reads an operation.json only when its
 * size or mtime changed. An op read once in a settled state is never looked at
 * again: the state machine has no transition out of one. So a query costs one
 * directory listing, a stat per op still in flight, and a read of the ops it
 * returns. The first pass still reads every record once, one at a time (only
 * the facts are kept); the server warms it in the background at boot, yielding
 * as it goes ({@link warmOpIndex}).
 *
 * The scan is shared with the pre-blessed-secrets check (pre-bless.ts), which
 * was the first to need it and kept its own copy.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OPS_BASE, TERMINAL_STATUSES, readOp } from "./op-store.js";
import type { Op } from "./types.js";

interface Seen<T> { mtimeMs: number; size: number; value: T | undefined; settled: boolean }

export interface OpScanner<T> {
  /** Every readable op's projection, by id, current as of this call. */
  refresh(): ReadonlyMap<string, T>;
  /** The same first pass, yielding to the event loop every few ops. */
  warm(pause?: () => Promise<void>): Promise<void>;
}

const WARM_BATCH = 50;

/**
 * An incremental scan of `opsDir`: `project` is what to keep of an op, and
 * `settled` says the op will never change again. An unreadable record is
 * remembered by its size and mtime and not read again until it changes.
 */
export function createOpScanner<T>(
  opsDir: string,
  read: (opId: string) => Op | null,
  project: (op: Op) => T,
  settled: (op: Op) => boolean,
): OpScanner<T> {
  const seen = new Map<string, Seen<T>>();
  const values = new Map<string, T>();

  const visit = (id: string): void => {
    let entry = seen.get(id);
    if (entry?.settled) return;
    let stat;
    try { stat = statSync(join(opsDir, id, "operation.json")); }
    catch { seen.delete(id); values.delete(id); return; } // a folder with no record yet
    if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) return;
    const op = read(id);
    entry = { mtimeMs: stat.mtimeMs, size: stat.size, value: op ? project(op) : undefined, settled: !!op && settled(op) };
    seen.set(id, entry);
    if (entry.value === undefined) values.delete(id); else values.set(id, entry.value);
  };

  const list = (): string[] => {
    let ids: string[];
    try { ids = readdirSync(opsDir); } catch { ids = []; } // no ops folder yet
    const present = new Set(ids);
    for (const id of seen.keys()) if (!present.has(id)) { seen.delete(id); values.delete(id); }
    return ids;
  };

  return {
    refresh() {
      for (const id of list()) visit(id);
      return values;
    },
    async warm(pause = () => new Promise<void>((resolve) => setImmediate(resolve))) {
      const ids = list();
      for (let i = 0; i < ids.length; i++) {
        visit(ids[i]);
        if ((i + 1) % WARM_BATCH === 0) await pause();
      }
    },
  };
}

/** What a query can ask about an op without reading it. */
export interface OpFacts {
  /** The chat the op belongs to (`op.sessionId`). */
  sessionId?: string;
  /** The session its canonical run is bound to. */
  canonicalSessionId?: string;
  type: string;
  status: Op["status"];
  appUrl?: string;
  /** Not finished: its status or its canonical state can still move. */
  open: boolean;
  /** It waits on other ops. */
  hasDependencies: boolean;
  /** When it last moved, in ms: finished, else started, else created. Absent
   *  when none of those dates can be read. */
  endedAt?: number;
}

const CANONICAL_TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function lastMovedAt(op: Op): number | undefined {
  const at = Date.parse(op.completedAt || op.startedAt || op.createdAt || "");
  return Number.isFinite(at) ? at : undefined;
}

function isSettled(op: Op): boolean {
  const state = op.canonical?.state;
  return TERMINAL_STATUSES.includes(op.status) && (state === undefined || CANONICAL_TERMINAL.has(state));
}

/** An op's facts: what the index keeps of it. */
export function opFactsOf(op: Op): OpFacts {
  const endedAt = lastMovedAt(op);
  return {
    ...(op.sessionId ? { sessionId: op.sessionId } : {}),
    ...(op.canonical?.sessionId ? { canonicalSessionId: op.canonical.sessionId } : {}),
    type: op.type,
    status: op.status,
    ...(op.appUrl ? { appUrl: op.appUrl } : {}),
    open: !isSettled(op),
    hasDependencies: (op.dependsOn?.length ?? 0) > 0,
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

let index: OpScanner<OpFacts> | undefined;
/** One index per process, over the store op-store reads (OPS_BASE). */
const theIndex = (): OpScanner<OpFacts> => (index ??= createOpScanner(OPS_BASE, readOp, opFactsOf, isSettled));

/** The ops whose facts match, read fresh from the store, in no set order. */
export function opsWhere(matches: (facts: OpFacts) => boolean): Op[] {
  const out: Op[] = [];
  for (const [id, facts] of theIndex().refresh()) {
    if (!matches(facts)) continue;
    const op = readOp(id);
    if (op) out.push(op);
  }
  return out;
}

/** The ids of the ops whose facts match, without reading any of them. */
export function opIdsWhere(matches: (facts: OpFacts) => boolean): string[] {
  const out: string[] = [];
  for (const [id, facts] of theIndex().refresh()) if (matches(facts)) out.push(id);
  return out;
}

/** The ids of the ops still in flight: what a recovery pass has to look at.
 *  Every other op is finished and can never need recovering. */
export function openOpIds(): string[] {
  return opIdsWhere((facts) => facts.open);
}

/** Fill the index in the background so the first query does not pay for it. */
export function warmOpIndex(): Promise<void> {
  return theIndex().warm();
}

/** Test seam: forget what was scanned (the store's folder was swapped). */
export function _resetOpIndexForTest(): void {
  index = undefined;
}
