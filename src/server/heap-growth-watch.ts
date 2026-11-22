/**
 * What is holding the heap when it grows.
 *
 * The server died of "JavaScript heap out of memory" in the middle of a build
 * (2026-11-22) and left nothing that said what held 4 GB: the last memory
 * figure in the log was fifty minutes old. The event-loop sentinel records
 * what the CPU was doing in a stall; this is its twin for memory.
 *
 * V8's sampling heap profiler runs from boot (one sample per MiB allocated,
 * which costs next to nothing). The first time the heap passes each of a few
 * fractions of its limit, the live allocations are written to
 * `<data dir>/logs/heap-growth-<time>.heapprofile` (Chrome DevTools opens it:
 * Memory → Load) and the log names the functions holding the most. A profile
 * counts only objects still alive, so it answers "who is holding it", not "who
 * allocated a lot".
 *
 * Limit: the check runs on the event loop, so memory that balloons inside one
 * synchronous call is seen only once that call returns.
 *
 * `LAX_HEAP_WATCH=0` turns it off.
 */
import { mkdirSync, readdirSync, unlinkSync, writeFile } from "node:fs";
import { join } from "node:path";
import { Session } from "node:inspector";
import { getHeapStatistics } from "node:v8";
import { getLaxDir } from "../lax-data-dir.js";
import { createLogger } from "../logger.js";

const logger = createLogger("server.heap-watch");

/** Fractions of the heap limit that each get one report per process. */
export const HEAP_REPORT_FRACTIONS: readonly number[] = [0.4, 0.6, 0.8];
const CHECK_MS = 5_000;
const SAMPLING_INTERVAL_BYTES = 1 << 20;
const KEPT_PROFILES = 6;
const NAMED_HOLDERS = 5;

/** The highest fraction `used` has newly passed, or null. Marks it (and every
 *  lower one) reported, so a heap that jumps two steps reports once. */
export function crossedFraction(usedBytes: number, limitBytes: number, reported: Set<number>): number | null {
  if (limitBytes <= 0) return null;
  let hit: number | null = null;
  for (const fraction of HEAP_REPORT_FRACTIONS) {
    if (usedBytes >= limitBytes * fraction && !reported.has(fraction)) hit = fraction;
  }
  if (hit === null) return null;
  for (const fraction of HEAP_REPORT_FRACTIONS) if (fraction <= hit) reported.add(fraction);
  return hit;
}

/** A node of V8's sampling heap profile. */
export interface HeapProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children?: HeapProfileNode[];
}

export interface Holder { where: string; calledFrom: string; bytes: number }

function frameLabel(node: HeapProfileNode): string {
  const { functionName, url, lineNumber } = node.callFrame;
  const file = url.replace(/^file:\/\/\/?/, "").split(/[\\/]/).slice(-3).join("/");
  return `${functionName || "(anonymous)"}${file ? ` (${file}:${lineNumber + 1})` : ""}`;
}

/** The call sites holding the most live memory, largest first: each with the
 *  frame that called it, since `JSON.parse` alone says nothing. */
export function topHolders(head: HeapProfileNode, count = NAMED_HOLDERS): Holder[] {
  const byPlace = new Map<string, Holder>();
  const walk = (node: HeapProfileNode, parent: HeapProfileNode | null): void => {
    if (node.selfSize > 0) {
      const where = frameLabel(node);
      const calledFrom = parent ? frameLabel(parent) : "";
      const key = `${where}\n${calledFrom}`;
      const entry = byPlace.get(key) ?? { where, calledFrom, bytes: 0 };
      entry.bytes += node.selfSize;
      byPlace.set(key, entry);
    }
    for (const child of node.children ?? []) walk(child, node);
  };
  walk(head, null);
  return [...byPlace.values()].sort((a, b) => b.bytes - a.bytes).slice(0, count);
}

const mb = (bytes: number): string => `${Math.round(bytes / 1e6).toLocaleString("en-US")} MB`;

/** The log line for a report: how full the heap is and who holds it. */
export function heapReportLine(usedBytes: number, limitBytes: number, holders: Holder[], path: string): string {
  const held = holders.length
    ? holders.map((h) => `${h.where}${h.calledFrom ? ` called from ${h.calledFrom}` : ""}: ${mb(h.bytes)}`).join("; ")
    : "no sampled allocation is still alive (the growth is outside the JavaScript heap's sampled objects)";
  return `[heap-watch] heap at ${mb(usedBytes)}, ${Math.round((usedBytes / limitBytes) * 100)}% of its ${mb(limitBytes)} limit. ` +
    `Holding the most: ${held}. Full profile: ${path}`;
}

function pruneOldProfiles(dir: string): void {
  try {
    const old = readdirSync(dir).filter((f) => f.startsWith("heap-growth-") && f.endsWith(".heapprofile")).sort().slice(0, -KEPT_PROFILES);
    for (const f of old) unlinkSync(join(dir, f));
  } catch { /* housekeeping: a file in use is pruned next time */ }
}

let started = false;

/** Start the watch for this process. Idempotent; never throws. */
export function startHeapGrowthWatch(): void {
  if (started || process.env.LAX_HEAP_WATCH === "0") return;
  started = true;
  let session: Session;
  try {
    session = new Session();
    session.connect();
  } catch (e) {
    logger.warn(`[heap-watch] unavailable: ${(e as Error).message}`);
    return;
  }
  const post = <T>(method: string, params: object = {}): Promise<T> =>
    new Promise((resolve, reject) => session.post(method, params, (err, res) => (err ? reject(err) : resolve(res as T))));
  post("HeapProfiler.startSampling", { samplingInterval: SAMPLING_INTERVAL_BYTES })
    .catch((e) => logger.warn(`[heap-watch] sampling failed to start: ${(e as Error).message}`));

  const reported = new Set<number>();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    const used = process.memoryUsage().heapUsed;
    const limit = getHeapStatistics().heap_size_limit;
    if (crossedFraction(used, limit, reported) === null) return;
    busy = true;
    const dir = join(getLaxDir(), "logs");
    const path = join(dir, `heap-growth-${new Date().toISOString().replace(/[:.]/g, "-")}.heapprofile`);
    post<{ profile: { head: HeapProfileNode } }>("HeapProfiler.getSamplingProfile")
      .then(({ profile }) => {
        try { mkdirSync(dir, { recursive: true }); } catch { /* the write reports it */ }
        writeFile(path, JSON.stringify(profile), (e) => { if (e) logger.warn(`[heap-watch] profile write failed: ${e.message}`); else pruneOldProfiles(dir); });
        logger.error(heapReportLine(used, limit, topHolders(profile.head), path));
      })
      .catch((e) => logger.warn(`[heap-watch] report failed at ${mb(used)}: ${(e as Error).message}`))
      .finally(() => { busy = false; });
  }, CHECK_MS);
  timer.unref();
}
