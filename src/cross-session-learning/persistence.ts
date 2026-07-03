import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";

import type { ActionEntry, SessionData } from "./types.js";
import { DATA_FILE, LAX_DIR, MS_PER_DAY, PRUNE_AGE_DAYS } from "./types.js";

// Recurring types (>=3 entries) keep at most this many of their most recent
// stale entries. The old unbounded keep-rule made homogeneous legacy data
// immortal: a frozen file of thousands of same-type actions could never
// shrink, and its tokenized artifacts kept being mined as "patterns".
export const MAX_STALE_PER_TYPE = 10;

export function ensureDir(): void {
  if (!existsSync(LAX_DIR)) {
    mkdirSync(LAX_DIR, { recursive: true });
  }
}

export function loadData(): SessionData {
  try {
    if (existsSync(DATA_FILE)) {
      const raw = readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        lastPrune: parsed.lastPrune || 0,
      };
    }
  } catch {
    // corrupted — start fresh
  }
  return { actions: [], lastPrune: Date.now() };
}

export function persistData(data: SessionData): void {
  try {
    const tmp = DATA_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, DATA_FILE);
  } catch {
    try {
      writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
    } catch {}
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
