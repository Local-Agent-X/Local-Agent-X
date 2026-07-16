// ── UI event store ── per-session ring buffers of user-interface activity
//
// Producers (in-app browser first; other surfaces later) emit `ui:<surface>`
// events on the global event bus; signals-ui-events.ts funnels them here.
// The store is the LAW for the event schema: unknown fields are stripped,
// malformed events are rejected, and every field is redacted BEFORE buffering —
// redaction is a property of the store, never a producer courtesy (mirrors
// the KB1/secret-ops posture in src/browser/). Field VALUES from sensitive
// inputs (passwords, tokens, form values) must never survive into a digest:
// query strings / fragments / URL userinfo are always stripped, opaque
// token-shaped path segments are elided, credential-shaped remainders are
// dropped, and surface/action must be plain labels (no key=value smuggling).
//
// Freshness is a TTL WINDOW, not a cursor: the digest always covers the last
// UI_DIGEST_TTL_MS of events, and the digest TEXT leads with its variable
// content (event count + latest timestamp) so the pipeline's 40-char signal
// hash distinguishes new activity from a repeat. A digest that gets dropped
// downstream (bleed gate, top-7 slice, contextual cut) is therefore RETRIED
// on later turns instead of being lost forever — the cursor design advanced
// before those gates and silently discarded activity. Residual (accepted):
// if an injection attempt is cut downstream and NO new event arrives before
// the next turn, the identical hash keeps it out until a new event lands.
//
// Bounded like the per-session cadence map in state.ts: LRU scopes (MRU touch
// on writes AND digest reads, evict oldest) plus a per-scope event cap. The
// global scope is pinned — it is every session's shared context and must not
// be evicted by a flood of one-off session scopes.

import { getRuntimeConfig } from "../config.js";

export interface UiEvent {
  /** Producing surface, e.g. "browser". Plain label — see LABEL_SHAPE. */
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
/** Digest window: activity older than this is no longer ambient context. */
export const UI_DIGEST_TTL_MS = 10 * 60_000;
const MAX_FIELD_LENGTH = 60;
const MAX_TARGET_LENGTH = 200;
const MAX_DIGEST_LINES = 4;
const MAX_FRAGMENTS_PER_LINE = 6;
const MAX_LINE_LENGTH = 240;

// A target whose host/path (post strip/elide) still looks credential-shaped
// gets dropped entirely — better to lose one breadcrumb than leak a secret.
const SENSITIVE_TARGET = /password|passwd|pwd|token|secret|api[-_]?key|credential|value=|otp\b|2fa/i;

// surface/action are LABELS. No '=', ':', '@', '?', '&' — the characters every
// key=value / token smuggle needs. A producer that violates this loses the
// whole event (fail closed), not just the field.
const LABEL_SHAPE = /^[\w .\/-]+$/;

// An opaque path segment: long, single-token, and containing digits (covers
// hex digests, base64 ids, session keys) or JWT-prefixed. Elided, not kept —
// `/reset/eyJhbGciOi...` becomes `/reset/…`.
const OPAQUE_SEGMENT = /^(eyJ[\w+/=.-]*|[\w%+=.-]{20,})$/;
const HAS_DIGIT = /\d/;

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
}

// Insertion order in a Map is its LRU order here (same pattern as
// state.ts getSessionCadence): touching re-inserts at the tail, so
// keys().next() is always the least-recently-used scope. The global
// scope is exempt from eviction.
const rings = new Map<string, UiEventRing>();

function touchRing(scope: string): UiEventRing {
  const existing = rings.get(scope);
  if (existing) {
    rings.delete(scope);
    rings.set(scope, existing);
    return existing;
  }
  const fresh: UiEventRing = { events: [] };
  rings.set(scope, fresh);
  while (rings.size > MAX_UI_EVENT_SESSIONS) {
    let evicted = false;
    for (const key of rings.keys()) {
      if (key === GLOBAL_UI_SCOPE) continue; // pinned
      rings.delete(key);
      evicted = true;
      break;
    }
    if (!evicted) break; // only the global scope remains
  }
  return fresh;
}

/**
 * Enforce the UiEvent schema on an untrusted value (producers reach this
 * through the untyped event bus). Returns a fresh object holding ONLY the
 * schema fields, or null when the event is unusable:
 *  - surface/action must be non-empty label-shaped strings (else reject —
 *    a '=' or ':' in a label is the value-smuggling pattern, fail closed);
 *  - ts must be a finite positive number (else stamped now — a producer's
 *    clock bug shouldn't erase the activity);
 *  - target/sessionId must be strings or they're dropped;
 *  - target is redacted: query/fragment/userinfo always stripped, opaque
 *    token-shaped segments elided, credential-shaped remainders dropped,
 *    length capped.
 */
export function sanitizeUiEvent(raw: unknown): UiEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.surface !== "string" || typeof r.action !== "string") return null;
  const surface = r.surface.trim().slice(0, MAX_FIELD_LENGTH);
  const action = r.action.trim().slice(0, MAX_FIELD_LENGTH);
  if (surface === "" || action === "") return null;
  if (!LABEL_SHAPE.test(surface) || !LABEL_SHAPE.test(action)) return null;

  const event: UiEvent = {
    surface,
    action,
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

export function redactTarget(target: string): string | null {
  // Query strings and fragments carry input VALUES (?value=..., #token=...)
  // — always stripped, no exceptions.
  let stripped = target.replace(/[?#].*$/, "").trim();
  if (stripped === "") return null;
  // URL userinfo (https://user:pass@host/..., //user@host, user:pass@host):
  // everything between the scheme/start and an '@' that precedes the first
  // path slash is credentials — strip it, keep the host.
  stripped = stripped.replace(/^([a-z][\w+.-]*:\/\/|\/\/)?[^\/]*@/i, "$1");
  // Opaque token-shaped path segments (hex digests, base64 ids, JWTs) are
  // elided so a secret embedded in the PATH can't ride along.
  stripped = stripped
    .split("/")
    .map(seg => (OPAQUE_SEGMENT.test(seg) && (HAS_DIGIT.test(seg) || seg.startsWith("eyJ")) ? "…" : seg))
    .join("/");
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

function windowedEventsFor(sessionId: string, now: number): UiEvent[] {
  const floor = now - UI_DIGEST_TTL_MS;
  const own = rings.get(sessionId)?.events ?? [];
  const shared = sessionId === GLOBAL_UI_SCOPE ? [] : rings.get(GLOBAL_UI_SCOPE)?.events ?? [];
  return [...own, ...shared].filter(e => e.ts > floor).sort((a, b) => a.ts - b.ts);
}

/** True when the session (or the global scope) has activity in the window. */
export function hasFreshUiEvents(sessionId: string, now = Date.now()): boolean {
  return windowedEventsFor(sessionId, now).length > 0;
}

/**
 * Distill the session's windowed activity (own ring + global scope) into at
 * most MAX_DIGEST_LINES human-readable lines, one per surface, prefixed with
 * the window's variable identity (event count + latest event time). That
 * prefix is deliberate: the signal pipeline dedupes on category + the first
 * 40 chars, so two digests are "the same signal" exactly when they describe
 * the same events, and a NEW event always mints a fresh hash. Consecutive
 * same-target repeats are deduped; navigations collapse into an "a → b"
 * chain. Returns null when the window is empty. Read-only apart from the
 * MRU touch that keeps an actively-digested session from being evicted.
 */
export function recentUiDigest(sessionId: string, now = Date.now()): UiDigest | null {
  if (!uiEventBusEnabled()) return null;
  if (sessionId !== GLOBAL_UI_SCOPE && rings.has(sessionId)) touchRing(sessionId);
  const windowed = windowedEventsFor(sessionId, now);
  if (windowed.length === 0) return null;

  // Drop consecutive duplicates (same surface+action+target back-to-back).
  const deduped: UiEvent[] = [];
  for (const e of windowed) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.surface === e.surface && prev.action === e.action && prev.target === e.target) continue;
    deduped.push(e);
  }

  const bySurface = new Map<string, UiEvent[]>();
  for (const e of deduped) {
    const list = bySurface.get(e.surface);
    if (list) list.push(e); else bySurface.set(e.surface, [e]);
  }

  const latestTs = windowed[windowed.length - 1].ts;
  const lines: string[] = [];
  for (const [surface, events] of bySurface) {
    if (lines.length >= MAX_DIGEST_LINES) break;
    lines.push(surfaceLine(surface, events));
  }

  const stamp = new Date(latestTs);
  const hh = String(stamp.getHours()).padStart(2, "0");
  const mm = String(stamp.getMinutes()).padStart(2, "0");
  const ss = String(stamp.getSeconds()).padStart(2, "0");
  return {
    text: `[${windowed.length} ui events, latest ${hh}:${mm}:${ss}] ${lines.join("\n")}`,
    latestTs,
    eventCount: windowed.length,
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
