import type { ActionEntry, SessionData } from "./types.js";
import { DATA_FILE, MS_PER_DAY, PRUNE_AGE_DAYS } from "./types.js";
import { createJsonStore, ensureDirFor } from "../../util/json-store.js";

// Recurring types (>=3 entries) keep at most this many of their most recent
// stale entries. The old unbounded keep-rule made homogeneous legacy data
// immortal: a frozen file of thousands of same-type actions could never
// shrink, and its tokenized artifacts kept being mined as "patterns".
export const MAX_STALE_PER_TYPE = 10;

const store = createJsonStore<SessionData>(DATA_FILE, {
  // Missing/corrupt file → lastPrune = now (fresh start, no immediate prune).
  defaults: () => ({ actions: [], candidates: [], lastPrune: Date.now() }),
  // Existing file with a missing/falsy lastPrune → 0 (prune-eligible),
  // matching the old `parsed.lastPrune || 0` read.
  upgrade: (parsed) =>
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? {
          ...parsed,
          candidates: Array.isArray((parsed as Partial<SessionData>).candidates)
            ? (parsed as Partial<SessionData>).candidates
            : [],
          lastPrune: (parsed as Partial<SessionData>).lastPrune || 0,
        }
      : parsed,
});

export function ensureDir(): void {
  ensureDirFor(DATA_FILE);
}

export function loadData(): SessionData {
  return store.load();
}

export function persistData(data: SessionData): void {
  try {
    store.save(data);
  } catch {
    // A failed persist has never crashed the learner; keep that contract.
    // (The old non-atomic direct-write fallback is gone — better a stale
    // file than a torn one.)
  }
}

// Returns true if data was modified (caller should persist).
export function autoPrune(data: SessionData): boolean {
  const now = Date.now();
  const lastPrune = data.lastPrune || 0;

  if (now - lastPrune < MS_PER_DAY) return false;

  const cutoff = now - PRUNE_AGE_DAYS * MS_PER_DAY;

  const typeCounts = new Map<string, number>();
  for (const a of data.actions) {
    typeCounts.set(a.type, (typeCounts.get(a.type) || 0) + 1);
  }

  const before = data.actions.length;
  const staleKept = new Map<string, number>();
  const kept: ActionEntry[] = [];
  // Walk newest-first so the bounded stale allowance goes to the most
  // recent entries of each recurring type.
  for (let i = data.actions.length - 1; i >= 0; i--) {
    const a = data.actions[i];
    if (a.timestamp > cutoff) {
      kept.push(a);
      continue;
    }
    if ((typeCounts.get(a.type) || 0) >= 3) {
      const soFar = staleKept.get(a.type) || 0;
      if (soFar < MAX_STALE_PER_TYPE) {
        staleKept.set(a.type, soFar + 1);
        kept.push(a);
      }
    }
  }
  kept.reverse();
  data.actions = kept;

  data.lastPrune = now;

  return data.actions.length !== before;
}
