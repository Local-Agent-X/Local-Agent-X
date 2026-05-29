import type { OrchestratorInput, ModuleSignal, TriageResult } from "./types.js";
import { orchestratorState, safeRun } from "./state.js";
import { getSignal } from "./registry.js";

export function gatherSignals(input: OrchestratorInput, triage: TriageResult): ModuleSignal[] {
  const signals: ModuleSignal[] = [];
  const allModules = [...triage.always, ...triage.conditional, ...triage.scheduled, ...triage.triggered];

  for (const mod of allModules) {
    const collected = safeRun(mod, () => runModule(mod, input), []);
    signals.push(...collected);
  }

  for (const sig of signals) {
    if (sig.confidence === undefined || sig.confidence === null) {
      sig.confidence = Math.min(1, sig.priority / 10);
    }
  }

  return signals;
}

export function runModule(name: string, input: OrchestratorInput): ModuleSignal[] {
  const start = Date.now();
  const signals: ModuleSignal[] = [];

  getSignal(name)?.run?.(input, signals);

  orchestratorState.moduleRunTimes[name] = Date.now() - start;
  return signals;
}
