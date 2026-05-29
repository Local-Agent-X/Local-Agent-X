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

  const storageFiles: Record<string, string> = {
    "emotional-memory": "emotional-history.json",
    "language-mirror": "language-style.json",
    "trust-engine": "trust-engine.json",
    "milestones": "milestones.json",
    "vulnerability": "vulnerability-shares.json",
    "corrections": "corrections.json",
    "shared-history": "shared-history.json",
    "inside-references": "inside-references.json",
    "growth-tracker": "growth-tracker.json",
    "narrative-memory": "narratives.json",
    "unspoken-detector": "unspoken-detector.json",
    "orchestrator": "orchestrator-state.json",
  };

  for (const [name, file] of Object.entries(storageFiles)) {
    const path = join(LAX_DIR, file);
    try {
      if (existsSync(path)) {
        const stat = readFileSync(path, "utf-8");
        storageSizes[name] = stat.length;
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
