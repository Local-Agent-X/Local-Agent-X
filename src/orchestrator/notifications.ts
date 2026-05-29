import type { OrchestratorInput, ModuleSignal, Notification } from "./types.js";
import { SIGNALS } from "./registry.js";
import { safeRun } from "./state.js";

export function extractNotifications(signals: ModuleSignal[], input: OrchestratorInput): Notification[] {
  const notifications: Notification[] = [];

  for (const sig of signals) {
    if (sig.category === "milestone") {
      notifications.push({
        type: "celebration",
        message: sig.signal,
        priority: sig.priority,
      });
    }
    if (sig.category === "followup") {
      notifications.push({
        type: "followup",
        message: sig.signal,
        priority: sig.priority,
      });
    }
    if (sig.category === "growth" && sig.priority >= 5) {
      notifications.push({
        type: "insight",
        message: sig.signal,
        priority: sig.priority,
      });
    }
    if (sig.category === "unspoken") {
      notifications.push({
        type: "insight",
        message: sig.signal,
        priority: sig.priority,
      });
    }
  }

  return notifications.sort((a, b) => b.priority - a.priority).slice(0, 3);
}

export function recordFromMessage(input: OrchestratorInput): void {
  for (const sig of SIGNALS) {
    if (sig.record) {
      safeRun(`${sig.id}:record`, () => sig.record!(input), undefined);
    }
  }
}
