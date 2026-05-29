import type { CognitiveSignal, ModuleScope } from "./types.js";
import { conversationalSignals } from "./signals-conversational.js";
import { metaSignals } from "./signals-meta.js";
import { backgroundSignals } from "./signals-background.js";

/**
 * The one cognitive-signal table. Every orchestrator facet — triage,
 * dispatch, recording, veto, scope, health — derives from this array, so a
 * module's identity is declared exactly once (on its entry) instead of being
 * restated as a string across triage, the dispatch switch, the scope map, the
 * veto list, the recording sequence, and the health table.
 *
 * To add a signal: append one entry. To remove one: delete it. Nothing else
 * to touch.
 */
export const SIGNALS: CognitiveSignal[] = [
  ...conversationalSignals,
  ...metaSignals,
  ...backgroundSignals,
];

const BY_ID = new Map<string, CognitiveSignal>(SIGNALS.map(s => [s.id, s]));

export function getSignal(id: string): CognitiveSignal | undefined {
  return BY_ID.get(id);
}

export function getModuleScope(id: string): ModuleScope {
  return BY_ID.get(id)?.scope ?? "profile";
}

export const criticalSignalIds: string[] = SIGNALS.filter(s => s.critical).map(s => s.id);
