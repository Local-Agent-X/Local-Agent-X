import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";

import type { SessionData } from "./types.js";
import { DATA_FILE, LAX_DIR, MS_PER_DAY, PRUNE_AGE_DAYS } from "./types.js";

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
  data.actions = data.actions.filter((a) => {
    if (a.timestamp > cutoff) return true;
    if ((typeCounts.get(a.type) || 0) >= 3) return true;
    return false;
  });

  data.lastPrune = now;

  return data.actions.length !== before;
}
