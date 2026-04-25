import type { ModuleSignal } from "./types.js";

export function applyVetoLayer(signals: ModuleSignal[]): { vetoed: boolean; reason?: string; overrideSignal?: ModuleSignal } {
  for (const sig of signals) {
    if (sig.source === "vulnerability-awareness" && sig.priority >= 8) {
      return {
        vetoed: true,
        reason: "Sacred/vulnerable topic detected — overriding normal tone",
        overrideSignal: { ...sig, priority: 10, confidence: 1.0 },
      };
    }
    if (sig.source === "contradiction-detector" && sig.confidence >= 0.8) {
      return {
        vetoed: true,
        reason: "High-confidence contradiction — must address before proceeding",
        overrideSignal: { ...sig, priority: 9, confidence: 1.0 },
      };
    }
    if (sig.source === "correction-learning" && sig.confidence >= 0.7) {
      return {
        vetoed: true,
        reason: "User correction detected — acknowledge and fix",
        overrideSignal: { ...sig, priority: 9, confidence: 1.0 },
      };
    }
  }
  return { vetoed: false };
}

export function calculateFusionConfidence(signals: ModuleSignal[]): number {
  if (signals.length === 0) return 0;
  let totalWeight = 0;
  let weightedSum = 0;
  for (const sig of signals) {
    const weight = sig.priority;
    totalWeight += weight;
    weightedSum += sig.confidence * weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

export function checkDeepPassNeeded(signals: ModuleSignal[], activatedModules: string[]): { needed: boolean; modules: string[] } {
  const criticalModules = ["vulnerability-awareness", "contradiction-detector", "correction-learning", "emotional-memory"];
  const lowConfidence: string[] = [];
  for (const sig of signals) {
    if (criticalModules.includes(sig.source) && sig.confidence < 0.4 && sig.confidence > 0.1) {
      lowConfidence.push(sig.source);
    }
  }
  for (const mod of activatedModules) {
    if (criticalModules.includes(mod) && !signals.some(s => s.source === mod)) {
      lowConfidence.push(mod);
    }
  }
  return { needed: lowConfidence.length > 0, modules: [...new Set(lowConfidence)] };
}

export function resolveConflicts(signals: ModuleSignal[]): ModuleSignal[] {
  const conflictPairs: Array<{ a: RegExp; b: RegExp; resolution: "higher-priority" | "safety-first" }> = [
    { a: /enthusias|positive|excited|match.*energy/i, b: /concise|brief|frustrated|solution.oriented/i, resolution: "safety-first" },
    { a: /casual|informal|slang/i, b: /gentle|sensitive|empathetic|careful/i, resolution: "safety-first" },
    { a: /take initiative|proactive/i, b: /ask.*before|confirm|clarify/i, resolution: "higher-priority" },
    { a: /personal.*reference|callback/i, b: /sensitive|vulnerable|sacred/i, resolution: "safety-first" },
  ];

  const resolved = [...signals];
  const toRemove = new Set<number>();

  for (const pair of conflictPairs) {
    const matchA = resolved.findIndex(s => pair.a.test(s.signal));
    const matchB = resolved.findIndex(s => pair.b.test(s.signal));
    if (matchA === -1 || matchB === -1 || matchA === matchB) continue;

    const sigA = resolved[matchA];
    const sigB = resolved[matchB];

    if (pair.resolution === "safety-first") {
      const safetyIdx = sigA.category === "vulnerability" || sigA.category === "correction" ? matchB : matchA;
      toRemove.add(safetyIdx);
    } else {
      toRemove.add(sigA.priority >= sigB.priority ? matchB : matchA);
    }
  }

  return resolved.filter((_, i) => !toRemove.has(i));
}
