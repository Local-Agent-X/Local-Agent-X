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
