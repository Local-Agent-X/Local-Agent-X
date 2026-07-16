// ── UI event store ── per-session ring buffers of user-interface activity
//
// Producers (in-app browser first; other surfaces later) emit `ui:<surface>`
// events on the global event bus; signals-ui-events.ts funnels them here.
// The store is the LAW for the event schema: unknown fields are stripped,
// malformed events are rejected, and targets are redacted BEFORE buffering —
// redaction is a property of the store, never a producer courtesy (mirrors
// the KB1/secret-ops posture in src/browser/). Field VALUES from sensitive
// inputs (passwords, tokens, form values) must never survive into a digest:
// query strings / fragments are always stripped, and a target whose path
// still smells credential-shaped is dropped outright.
//
// Bounded exactly like the per-session cadence map in state.ts: LRU scopes
// (MRU touch, evict oldest) plus a per-scope event cap, so a long-lived
// process can never grow this without limit.

import { getRuntimeConfig } from "../config.js";

export interface UiEvent {
  /** Producing surface, e.g. "browser". */
  surface: string;
  /** What happened, e.g. "navigate", "title", "login-page", "tab-open". */
  action: string;
  /** Host+path only — NEVER credentials or input values (enforced here). */
  target?: string;
  /** Owning session; events without one land in the shared global scope. */
  sessionId?: string;
  ts: number;
}

export interface UiDigest {
  text: string;
  latestTs: number;
  eventCount: number;
}

/** Scope for events with no sessionId — visible to every session's digest. */
export const GLOBAL_UI_SCOPE = "global";
export const MAX_UI_EVENT_SESSIONS = 200;
export const MAX_UI_EVENTS_PER_SESSION = 50;
const MAX_FIELD_LENGTH = 60;
const MAX_TARGET_LENGTH = 200;
const MAX_DIGEST_LINES = 4;
const MAX_FRAGMENTS_PER_LINE = 6;
const MAX_LINE_LENGTH = 240;

// A target whose host/path (post query-strip) still looks credential-shaped
// gets dropped entirely — better to lose one breadcrumb than leak a secret.
const SENSITIVE_TARGET = /password|passwd|pwd|token|secret|api[-_]?key|credential|value=|otp\b|2fa/i;

/**
 * Master switch (Settings → Security). Read live on every ingest AND every
 * digest so flipping it off stops the pipeline on the very next event — no
 * restart.
 */
export function uiEventBusEnabled(): boolean {
  return getRuntimeConfig().enableUiEventBus !== false;
}

interface UiEventRing {
  events: UiEvent[];
  /** Freshness cursor for THIS session's digests (covers global events too). */
  lastDigestTs: number;
}

// Insertion order in a Map is its LRU order here (same pattern as
// state.ts getSessionCadence): reading re-inserts at the tail, so
// keys().next() is always the least-recently-used scope.
const rings = new Map<string, UiEventRing>();

function touchRing(scope: string): UiEventRing {
  const existing = rings.get(scope);
  if (existing) {
    rings.delete(scope);
    rings.set(scope, existing);
    return existing;
  }
  const fresh: UiEventRing = { events: [], lastDigestTs: 0 };
  rings.set(scope, fresh);
  while (rings.size > MAX_UI_EVENT_SESSIONS) {
    const oldest = rings.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    rings.delete(oldest);
  }
  return fresh;
}

/**
 * Enforce the UiEvent schema on an untrusted value (producers reach this
 * through the untyped event bus). Returns a fresh object holding ONLY the
 * schema fields, or null when the event is unusable:
 *  - surface/action must be non-empty strings (else reject);
 *  - ts must be a finite positive number (else stamped now — a producer's
 *    clock bug shouldn't erase the activity);
 *  - target/sessionId must be strings or they're dropped;
 *  - target is redacted: query/fragment always stripped, credential-shaped
 *    remainders dropped, length capped.
 */
export function sanitizeUiEvent(raw: unknown): UiEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.surface !== "string" || r.surface.trim() === "") return null;
  if (typeof r.action !== "string" || r.action.trim() === "") return null;

  const event: UiEvent = {
    surface: r.surface.trim().slice(0, MAX_FIELD_LENGTH),
    action: r.action.trim().slice(0, MAX_FIELD_LENGTH),
    ts: typeof r.ts === "number" && Number.isFinite(r.ts) && r.ts > 0 ? r.ts : Date.now(),
  };
  if (typeof r.sessionId === "string" && r.sessionId.trim() !== "") {
    event.sessionId = r.sessionId.trim();
  }
  if (typeof r.target === "string") {
    const redacted = redactTarget(r.target);
    if (redacted !== null) event.target = redacted;
  }
  return event;
}

function redactTarget(target: string): string | null {
  // Query strings and fragments carry input VALUES (?value=..., #token=...)
  // — always stripped, no exceptions.
  const stripped = target.replace(/[?#].*$/, "").trim();
  if (stripped === "") return null;
  if (SENSITIVE_TARGET.test(stripped)) return null;
  return stripped.length > MAX_TARGET_LENGTH ? stripped.slice(0, MAX_TARGET_LENGTH) : stripped;
}

/** Ingest one event. No-op (no buffering at all) while the toggle is off. */
export function recordUiEvent(event: UiEvent): void {
  if (!uiEventBusEnabled()) return;
  const clean = sanitizeUiEvent(event);
  if (!clean) return;
  const ring = touchRing(clean.sessionId ?? GLOBAL_UI_SCOPE);
  ring.events.push(clean);
  if (ring.events.length > MAX_UI_EVENTS_PER_SESSION) {
    ring.events.splice(0, ring.events.length - MAX_UI_EVENTS_PER_SESSION);
  }
}

function freshEventsFor(sessionId: string, sinceTs: number): UiEvent[] {
  const own = rings.get(sessionId)?.events ?? [];
  const shared = sessionId === GLOBAL_UI_SCOPE ? [] : rings.get(GLOBAL_UI_SCOPE)?.events ?? [];
  return [...own, ...shared].filter(e => e.ts > sinceTs).sort((a, b) => a.ts - b.ts);
}

/** True when the session (or the global scope) has undigested events. */
export function hasFreshUiEvents(sessionId: string): boolean {
  const cursor = rings.get(sessionId)?.lastDigestTs ?? 0;
  return freshEventsFor(sessionId, cursor).length > 0;
}

/** The session's freshness cursor — pass it to digestSince, then advance. */
export function getLastDigestTs(sessionId: string): number {
  return rings.get(sessionId)?.lastDigestTs ?? 0;
}

/** Advance the cursor after a digest was actually emitted (never rewinds). */
export function advanceDigestTs(sessionId: string, ts: number): void {
  const ring = touchRing(sessionId);
  if (ts > ring.lastDigestTs) ring.lastDigestTs = ts;
}

/**
 * Distill the session's undigested activity (own ring + global scope) into
 * at most MAX_DIGEST_LINES human-readable lines, one per surface. Consecutive
 * same-target repeats are deduped; navigations collapse into a "a → b" chain.
 * Returns null when there's nothing fresh. Read-only: the caller advances
 * the cursor via advanceDigestTs once the digest is actually used.
 */
export function digestSince(sessionId: string, sinceTs: number): UiDigest | null {
  if (!uiEventBusEnabled()) return null;
  const fresh = freshEventsFor(sessionId, sinceTs);
  if (fresh.length === 0) return null;

  // Drop consecutive duplicates (same surface+action+target back-to-back).
  const deduped: UiEvent[] = [];
  for (const e of fresh) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.surface === e.surface && prev.action === e.action && prev.target === e.target) continue;
    deduped.push(e);
  }

  const bySurface = new Map<string, UiEvent[]>();
  for (const e of deduped) {
    const list = bySurface.get(e.surface);
    if (list) list.push(e); else bySurface.set(e.surface, [e]);
  }

  const lines: string[] = [];
  for (const [surface, events] of bySurface) {
    if (lines.length >= MAX_DIGEST_LINES) break;
    lines.push(surfaceLine(surface, events));
  }

  return {
    text: lines.join("\n"),
    latestTs: fresh[fresh.length - 1].ts,
    eventCount: fresh.length,
  };
}

function surfaceLine(surface: string, events: UiEvent[]): string {
  const fragments: string[] = [];
  let navChain: string[] = [];
  const flushNav = (): void => {
    if (navChain.length === 0) return;
    fragments.push(navChain.length === 1 ? `user navigated to ${navChain[0]}` : `user navigated ${navChain.join(" → ")}`);
    navChain = [];
  };

  for (const e of events) {
    if (e.action === "navigate" && e.target) {
      if (navChain[navChain.length - 1] !== e.target) navChain.push(e.target);
      continue;
    }
    flushNav();
    if (e.action === "title" && e.target) {
      fragments.push(`page title '${e.target}'`);
    } else {
      fragments.push(e.target ? `${e.action} '${e.target}'` : e.action);
    }
  }
  flushNav();

  const label = surface.charAt(0).toUpperCase() + surface.slice(1);
  let line = `${label}: ${fragments.slice(0, MAX_FRAGMENTS_PER_LINE).join("; ")}`;
  if (line.length > MAX_LINE_LENGTH) line = line.slice(0, MAX_LINE_LENGTH - 3) + "...";
  return line;
}

/** Liveness probe for the orchestrator health report. */
export function uiEventStoreHealth(): { scopes: number; enabled: boolean } {
  return { scopes: rings.size, enabled: uiEventBusEnabled() };
}

/** Number of scopes currently tracked — for tests and health probes. */
export function uiEventScopeCount(): number {
  return rings.size;
}

export function _resetUiEventStoreForTest(): void {
  rings.clear();
}
