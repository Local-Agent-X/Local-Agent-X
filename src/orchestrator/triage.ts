import type { OrchestratorInput, TriageResult } from "./types.js";
import { SIGNALS } from "./registry.js";
import { safeRun } from "./state.js";

export function triageModules(input: OrchestratorInput, msgCount: number): TriageResult {
  const result: TriageResult = {
    always: [],
    conditional: [],
    scheduled: [],
    triggered: [],
  };

  for (const sig of SIGNALS) {
    if (!sig.triage) continue;
    const bucket = safeRun(sig.id, () => sig.triage!({ input, msgCount }), null);
    if (bucket) result[bucket].push(sig.id);
  }

  result.always = Array.from(new Set(result.always));
  result.conditional = Array.from(new Set(result.conditional));
  result.scheduled = Array.from(new Set(result.scheduled));
  result.triggered = Array.from(new Set(result.triggered));

  return result;
}
