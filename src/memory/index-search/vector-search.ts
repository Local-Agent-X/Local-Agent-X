import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { Chunk } from "../types.js";
import { createLogger } from "../../logger.js";
import { scanChunks, type VectorScanRequest } from "./vector-search-worker.js";

const logger = createLogger("memory.vector-search");

/**
 * Synchronous full-corpus cosine scan. The implementation lives in
 * vector-search-worker.ts (see its header for why) — this is the same code
 * the worker executes, so on-thread and off-thread results are identical by
 * construction. Prefer searchVectorOffThread on any hot path: this scan
 * blocks the calling event loop for seconds on large corpora.
 */
export function searchVector(
  db: InstanceType<typeof Database>,
  queryVec: number[],
  limit: number,
  sources?: string[],
  sessionFilter?: string | null
): Array<Chunk & { score: number }> {
  return scanChunks(db, queryVec, limit, sources, sessionFilter);
}

type WorkerResponse =
  | { ok: true; results: Array<Chunk & { score: number }> }
  | { ok: false; message: string };

// Under tsx/vitest this module's URL ends in .ts and the worker source must
// be loaded through tsx; the compiled dist tree spawns the plain .js file.
const IS_TS_RUNTIME = import.meta.url.endsWith(".ts");

function workerSpawnSpec(): { path: string; execArgv: string[] | undefined } {
  const workerUrl = new URL(
    IS_TS_RUNTIME ? "./vector-search-worker.ts" : "./vector-search-worker.js",
    import.meta.url
  );
  return {
    path: fileURLToPath(workerUrl),
    execArgv: IS_TS_RUNTIME ? ["--import", "tsx"] : undefined,
  };
}

/**
 * Runs the vector scan in a worker_thread against its own short-lived
 * readonly connection (open → scan → close), keeping the main event loop
 * free. The synchronous scan measured 13-21s on a 45k-chunk corpus and froze
 * the whole server when it ran on-loop.
 */
export async function searchVectorOffThread(
  db: InstanceType<typeof Database>,
  queryVec: number[],
  limit: number,
  sources?: string[],
  sessionFilter?: string | null
): Promise<Array<Chunk & { score: number }>> {
  // In-memory databases are invisible to a second connection — scan in
  // process (tests and ephemeral indexes only; the freeze was file-backed).
  if (db.memory || !db.name) {
    return searchVector(db, queryVec, limit, sources, sessionFilter);
  }

  try {
    return await runScanWorker({ dbPath: db.name, queryVec, limit, sources, sessionFilter });
  } catch (e) {
    // Same results either way — the fallback only re-pays the loop cost, so
    // surface it loudly rather than shipping a memory-less turn.
    logger.warn(
      "[memory] vector-search worker failed, falling back to in-process scan:",
      (e as Error).message
    );
    return searchVector(db, queryVec, limit, sources, sessionFilter);
  }
}

function runScanWorker(request: VectorScanRequest): Promise<Array<Chunk & { score: number }>> {
  const { path, execArgv } = workerSpawnSpec();
  return new Promise((resolve, reject) => {
    const worker = new Worker(path, { workerData: request, execArgv });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };
    worker.once("message", (msg: WorkerResponse) => {
      finish(() => (msg.ok ? resolve(msg.results) : reject(new Error(msg.message))));
    });
    worker.once("error", (err) => finish(() => reject(err)));
    worker.once("exit", (code) => {
      finish(() => reject(new Error(`vector-search worker exited (code ${code}) without a result`)));
    });
  });
}
