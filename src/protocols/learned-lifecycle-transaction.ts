import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { learnedProtocolsDir } from "./loader.js";

const LOCK_TIMEOUT_MS = 5_000;

function mutexPath(): string {
  return join(dirname(learnedProtocolsDir()), "learned-lifecycle.lock.sqlite");
}

export function withLearnedLifecycleTransaction<T>(mutation: () => T): T {
  const path = mutexPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { timeout: LOCK_TIMEOUT_MS });
  try {
    db.pragma(`busy_timeout = ${LOCK_TIMEOUT_MS}`);
    return db.transaction(mutation).immediate();
  } finally {
    db.close();
  }
}
