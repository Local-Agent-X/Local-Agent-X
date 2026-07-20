import type { ServerEvent } from "../types.js";

type SessionEventObserver = (event: ServerEvent, version: number) => void;

export interface SessionEventJournalEntry { event: ServerEvent; version: number }

const MAX_JOURNAL_EVENTS = 128;
const observers = new Map<string, {
  listeners: Set<SessionEventObserver>;
  version: number;
  journal: SessionEventJournalEntry[];
}>();

export function subscribeSessionEvents(sessionId: string, observer: SessionEventObserver): () => void {
  if (!sessionId) return () => {};
  let state = observers.get(sessionId);
  if (!state) {
    state = { listeners: new Set(), version: 0, journal: [] };
    observers.set(sessionId, state);
  }
  state.listeners.add(observer);
  return () => {
    state?.listeners.delete(observer);
    if (state?.listeners.size === 0) observers.delete(sessionId);
  };
}

export function sessionEventHighWater(sessionId: string): number {
  return observers.get(sessionId)?.version ?? 0;
}

export function sessionEventJournalSince(sessionId: string, version: number): SessionEventJournalEntry[] {
  return (observers.get(sessionId)?.journal ?? []).filter(entry => entry.version > version);
}

export function notifySessionEventObservers(sessionId: string, event: ServerEvent): void {
  const state = observers.get(sessionId);
  if (!state) return;
  const version = ++state.version;
  state.journal.push({ event, version });
  if (state.journal.length > MAX_JOURNAL_EVENTS) state.journal.splice(0, state.journal.length - MAX_JOURNAL_EVENTS);
  for (const observer of [...state.listeners]) {
    try { observer(event, version); } catch { /* passive observers never break chat delivery */ }
  }
}
