import type { ModuleSignal, Adaptation } from "./types.js";

export function buildAdaptations(signals: ModuleSignal[]): Adaptation[] {
  const adaptations: Adaptation[] = [];

  for (const sig of signals) {
    if (sig.category === "vulnerability") {
      adaptations.push({
        type: "tone",
        instruction: "Be extra gentle and empathetic. Avoid being dismissive or clinical.",
        priority: 9,
      });
    }
    if (sig.category === "correction" || sig.category === "correction-context") {
      adaptations.push({
        type: "accuracy",
        instruction: "User just corrected you. Acknowledge the mistake directly and adjust.",
        priority: 9,
      });
    }
    if (sig.category === "emotion" && sig.signal.includes("frustrated")) {
      adaptations.push({
        type: "pace",
        instruction: "User seems frustrated. Be concise, solution-oriented, skip pleasantries.",
        priority: 7,
      });
    }
    if (sig.category === "emotion" && (sig.signal.includes("excited") || sig.signal.includes("happy"))) {
      adaptations.push({
        type: "energy",
        instruction: "Match the user's positive energy. Be enthusiastic.",
        priority: 4,
      });
    }
    if (sig.category === "contradiction") {
      adaptations.push({
        type: "clarification",
        instruction: "Something contradicts earlier information. Gently ask to clarify, don't assume.",
        priority: 7,
      });
    }
    if (sig.category === "style") {
      adaptations.push({
        type: "style",
        instruction: sig.signal,
        priority: 3,
      });
    }
  }

  const byType = new Map<string, Adaptation>();
  for (const a of adaptations.sort((x, y) => y.priority - x.priority)) {
    if (!byType.has(a.type)) byType.set(a.type, a);
  }

  return Array.from(byType.values());
}
