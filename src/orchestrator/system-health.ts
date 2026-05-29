import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { HealthReport } from "./types.js";
import { LAX_DIR } from "./types.js";
import { SIGNALS } from "./registry.js";
import { orchestratorState } from "./state.js";

export function getSystemHealth(): HealthReport {
  const modulesLoaded: string[] = [];
  const storageSizes: Record<string, number> = {};

  for (const sig of SIGNALS) {
    if (!sig.health) continue;
    try {
      sig.health();
      modulesLoaded.push(sig.id);
    } catch { /* module failed to load */ }
  }

  // Storage sizes derive from the registry: each signal that persists state
  // declares its storageFile. The orchestrator's own state is the one
  // non-signal entry.
  const storageTargets: Array<[string, string]> = [
    ...SIGNALS.filter(s => s.storageFile).map(s => [s.id, s.storageFile!] as [string, string]),
    ["orchestrator", "orchestrator-state.json"],
  ];
  for (const [name, file] of storageTargets) {
    const path = join(LAX_DIR, file);
    try {
      if (existsSync(path)) {
        storageSizes[name] = readFileSync(path, "utf-8").length;
      }
    } catch { /* skip */ }
  }

  const errorCounts: Record<string, number> = {};
  for (const err of orchestratorState.errorLog) {
    errorCounts[err.module] = (errorCounts[err.module] || 0) + 1;
  }

  return {
    modulesLoaded,
    storageSizes,
    lastRunTimes: { ...orchestratorState.moduleRunTimes },
    errorCounts,
    uptime: Date.now() - (orchestratorState.lastProcessedAt || Date.now()),
  };
}
