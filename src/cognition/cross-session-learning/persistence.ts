import type { SessionData } from "./types.js";
import { DATA_FILE } from "./types.js";
import { createJsonStore, ensureDirFor } from "../../util/json-store.js";
import Database from "better-sqlite3";

const MUTEX_FILE = `${DATA_FILE}.lock.sqlite`;
const LOCK_TIMEOUT_MS = 5_000;

const store = createJsonStore<SessionData>(DATA_FILE, {
  defaults: () => ({ actions: [], candidates: [] }),
  // Only the candidates survive a load. The retired run log's entries and its
  // `lastPrune` stamp are dropped; `actions` is kept, empty (see SessionData).
  upgrade: (parsed) =>
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? {
          actions: [],
          candidates: Array.isArray((parsed as Partial<SessionData>).candidates)
            ? (parsed as Partial<SessionData>).candidates
            : [],
        }
      : parsed,
});

export function ensureDir(): void {
  ensureDirFor(DATA_FILE);
}

export function loadData(): SessionData {
  return store.load();
}

export interface CommittedLearningMutation<T> {
  data: SessionData;
  value: T;
}

export function mutateData<T>(
  mutation: (data: SessionData) => T,
): CommittedLearningMutation<T> | null {
  let db: Database.Database | undefined;
  let mutationError: unknown;
  let mutationFailed = false;
  try {
    ensureDirFor(MUTEX_FILE);
    db = new Database(MUTEX_FILE, { timeout: LOCK_TIMEOUT_MS });
    db.pragma(`busy_timeout = ${LOCK_TIMEOUT_MS}`);
    db.exec("BEGIN IMMEDIATE");

    const data = store.load();
    let value: T;
    try {
      value = mutation(data);
    } catch (error) {
      mutationFailed = true;
      mutationError = error;
      throw error;
    }
    const committedData = structuredClone(data);
    store.save(data);
    db.exec("COMMIT");
    return { data: committedData, value };
  } catch (error) {
    if (db) {
      try { db.exec("ROLLBACK"); } catch { /* original failure wins */ }
    }
    if (mutationFailed) throw mutationError;
    return null;
  } finally {
    try { db?.close(); } catch { /* a closed mutex needs no recovery */ }
  }
}
