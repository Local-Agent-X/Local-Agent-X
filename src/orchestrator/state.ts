import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { OrchestratorState } from "./types.js";
import { LAX_DIR, STATE_FILE } from "./types.js";

function loadState(): OrchestratorState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch { /* start fresh */ }
  return {
    messageCount: 0,
    lastProcessedAt: 0,
    lastBackgroundRun: 0,
    lastSignalHashes: [],
    errorLog: [],
    moduleRunTimes: {},
  };
}

export function saveState(state: OrchestratorState): void {
  if (!existsSync(LAX_DIR)) mkdirSync(LAX_DIR, { recursive: true });
  const tmp = STATE_FILE + "." + randomBytes(4).toString("hex") + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  try { renameSync(tmp, STATE_FILE); } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

export const orchestratorState: OrchestratorState = loadState();

// ── Per-session cadence store ───────────────────────────────
//
// messageCount and lastSignalHashes must NOT be process-global: a module's
// every-N-messages cadence would then count across unrelated sessions, and
// session B's identical signal would be dedup-suppressed by a hash session A
// last emitted (AM-9 symptom a). Each session gets its own counter + recent
// hash ring. Bounded by an LRU cap so a long-lived process that touches many
// sessions can't grow the map without limit.

export interface SessionCadence {
  messageCount: number;
  lastSignalHashes: string[];
}

export const MAX_CADENCE_SESSIONS = 200;

// Insertion order in a Map is its LRU order here: reading an entry re-inserts
// it at the tail, so keys().next() is always the least-recently-used session.
const sessionCadences = new Map<string, SessionCadence>();

/**
 * Return the mutable cadence entry for a session, creating it on first use.
 * Marks the session most-recently-used and evicts the oldest sessions past
 * MAX_CADENCE_SESSIONS so the map stays bounded for the process lifetime.
 */
export function getSessionCadence(sessionId: string): SessionCadence {
  const existing = sessionCadences.get(sessionId);
  if (existing) {
    // Touch → move to the MRU (tail) position.
    sessionCadences.delete(sessionId);
    sessionCadences.set(sessionId, existing);
    return existing;
  }
  const fresh: SessionCadence = { messageCount: 0, lastSignalHashes: [] };
  sessionCadences.set(sessionId, fresh);
  while (sessionCadences.size > MAX_CADENCE_SESSIONS) {
    const oldest = sessionCadences.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    sessionCadences.delete(oldest);
  }
  return fresh;
}

/** Number of sessions currently tracked — for tests and health probes. */
export function sessionCadenceCount(): number {
  return sessionCadences.size;
}

export function safeRun<T>(name: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    orchestratorState.errorLog.push({ module: name, error: msg, timestamp: Date.now() });
    if (orchestratorState.errorLog.length > 200) orchestratorState.errorLog.splice(0, 100);
    return fallback;
  }
}
