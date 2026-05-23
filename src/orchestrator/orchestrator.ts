import type { OrchestratorInput, OrchestratorOutput, BackgroundReport, HealthReport } from "./types.js";
import type { MemoryIndex } from "../memory.js";

import { processMessageImpl } from "./process-message-impl.js";
import { runBackground as runBackgroundImpl } from "./background-runner.js";
import { getSystemHealth as getSystemHealthImpl } from "./system-health.js";

// Re-exported for the bleed-gate regression test in
// test/orchestrator-resume-bleed.test.ts, which imports them from this path.
export { topicalKeywords, signalTopicallyRelevant } from "./topical-helpers.js";

export class MemoryOrchestrator {
  private static instance: MemoryOrchestrator;

  private constructor() {}

  static getInstance(): MemoryOrchestrator {
    if (!MemoryOrchestrator.instance) {
      MemoryOrchestrator.instance = new MemoryOrchestrator();
    }
    return MemoryOrchestrator.instance;
  }

  processMessage(input: OrchestratorInput): Promise<OrchestratorOutput> {
    return processMessageImpl(input);
  }

  runBackground(memoryIndex?: MemoryIndex): BackgroundReport {
    return runBackgroundImpl(memoryIndex);
  }

  getSystemHealth(): HealthReport {
    return getSystemHealthImpl();
  }
}
