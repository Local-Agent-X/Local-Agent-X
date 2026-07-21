import type { CanonicalEvent } from "./types.js";
import { projectCanonicalEvent } from "./event-emitter.js";
import {
  acknowledgeProcessRelayTarget,
  cleanupCompletedProcessRelay,
  readProcessRelayGenerations,
  withProcessRelayLock,
  type ProcessRelayGenerationState,
} from "./process-relay-journal.js";
import type { ProcessRelayRecord, ProcessRelayTarget } from "./process-relay-contract.js";

export type ProcessRelayProjector = (
  state: Readonly<ProcessRelayGenerationState>,
  record: Readonly<ProcessRelayRecord>,
  target: ProcessRelayTarget,
) => boolean | void;

const reconciling = new Set<string>();

/** Ordered, serialized replay. False or throw leaves the exact target pending. */
export function reconcileProcessRelay(opId: string, project: ProcessRelayProjector): number {
  if (reconciling.has(opId)) return 0;
  reconciling.add(opId);
  try {
    return withProcessRelayLock(opId, () => {
      let applied = 0;
      const generations = readProcessRelayGenerations(opId);
      for (const state of generations) {
        for (const record of state.records) {
          const acknowledged = state.acknowledgements.get(record.cursor) ?? new Set<ProcessRelayTarget>();
          for (const target of record.targets) {
            if (acknowledged.has(target)) continue;
            if (project(state, record, target) === false) return applied;
            acknowledgeProcessRelayTarget(state, record.cursor, target);
            applied++;
          }
          if (record.targets.some(target => !(state.acknowledgements.get(record.cursor)?.has(target)))) {
            return applied;
          }
        }
      }
      cleanupCompletedProcessRelay(opId);
      return applied;
    }) ?? 0;
  } finally {
    reconciling.delete(opId);
  }
}

export function canonicalRelayEvent(record: ProcessRelayRecord): CanonicalEvent {
  if (record.kind !== "canonical-event") throw new Error("process relay record is not canonical");
  return record.payload as CanonicalEvent;
}

/** E4C projects durable non-browser effects. E4D owns browser render ACK. */
export const projectProcessRelayTarget: ProcessRelayProjector = (_state, record, target) => {
  if (target === "browser-render") return false;
  projectCanonicalEvent(canonicalRelayEvent(record), true);
  return true;
};
