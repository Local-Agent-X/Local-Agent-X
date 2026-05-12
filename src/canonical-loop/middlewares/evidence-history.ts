/**
 * Per-op evidence history — used by mid-turn-stale + post-turn-detector to
 * detect "agent is spinning, no new evidence" patterns.
 *
 * Lives in its own module (not turn-loop.ts) so state-machine.ts can drop
 * it on terminal without taking a turn-loop import dependency — turn-loop
 * imports state-machine transitively via checkpoint.ts, and the back-edge
 * would form a cycle.
 */

const HISTORIES = new Map<string, number[]>();

export function getEvidenceHistory(opId: string): number[] {
  let h = HISTORIES.get(opId);
  if (!h) { h = []; HISTORIES.set(opId, h); }
  return h;
}

export function clearEvidenceHistory(opId: string): void {
  HISTORIES.delete(opId);
}

export function _resetEvidenceHistories(): void {
  HISTORIES.clear();
}
