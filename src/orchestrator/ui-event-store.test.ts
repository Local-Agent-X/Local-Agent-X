import { describe, it, expect, beforeEach, vi } from "vitest";

// The store reads the enableUiEventBus toggle live via getRuntimeConfig();
// mock it with a mutable flag so tests can flip the switch mid-flight
// without touching disk. ui-event-store.ts imports nothing else from config.
const mock = vi.hoisted(() => ({ config: { enableUiEventBus: true } as { enableUiEventBus: boolean } }));
vi.mock("../config.js", () => ({
  getRuntimeConfig: () => mock.config,
}));

import {
  GLOBAL_UI_SCOPE,
  MAX_UI_EVENTS_PER_SESSION,
  MAX_UI_EVENT_SESSIONS,
  _resetUiEventStoreForTest,
  advanceDigestTs,
  digestSince,
  getLastDigestTs,
  hasFreshUiEvents,
  recordUiEvent,
  sanitizeUiEvent,
  uiEventScopeCount,
  type UiEvent,
} from "./ui-event-store.js";

function ev(overrides: Partial<UiEvent> & Record<string, unknown> = {}): UiEvent {
  return { surface: "browser", action: "navigate", target: "x.com", sessionId: "s1", ts: 1000, ...overrides } as UiEvent;
}

beforeEach(() => {
  mock.config = { enableUiEventBus: true };
  _resetUiEventStoreForTest();
});

describe("sanitizeUiEvent — the schema is a law of the store", () => {
  it("strips fields outside the pinned schema", () => {
    const clean = sanitizeUiEvent({ ...ev(), password: "hunter2", extra: { deep: true } });
    expect(clean).toEqual({ surface: "browser", action: "navigate", target: "x.com", sessionId: "s1", ts: 1000 });
    expect(Object.keys(clean!).sort()).toEqual(["action", "sessionId", "surface", "target", "ts"]);
  });

  it("rejects non-objects and events missing surface/action", () => {
    expect(sanitizeUiEvent(null)).toBeNull();
    expect(sanitizeUiEvent("ui:browser")).toBeNull();
    expect(sanitizeUiEvent({ action: "navigate", ts: 1 })).toBeNull();
    expect(sanitizeUiEvent({ surface: "browser", action: "", ts: 1 })).toBeNull();
    expect(sanitizeUiEvent({ surface: 42, action: "navigate", ts: 1 })).toBeNull();
  });

  it("drops non-string target/sessionId and stamps a missing/invalid ts", () => {
    const before = Date.now();
    const clean = sanitizeUiEvent({ surface: "browser", action: "tab-open", target: 7, sessionId: 9, ts: "soon" });
    expect(clean!.target).toBeUndefined();
    expect(clean!.sessionId).toBeUndefined();
    expect(clean!.ts).toBeGreaterThanOrEqual(before);
  });

  it("always strips query strings and fragments from target (values live there)", () => {
    expect(sanitizeUiEvent(ev({ target: "x.com/login?value=hunter2&user=peter" }))!.target).toBe("x.com/login");
    expect(sanitizeUiEvent(ev({ target: "x.com/cb#access_token=abc" }))!.target).toBe("x.com/cb");
  });

  it("drops credential-shaped targets outright", () => {
    for (const target of ["x.com/reset-password", "x.com/api_key/rotate", "id.x.com/token/refresh", "x.com/secret-notes"]) {
      expect(sanitizeUiEvent(ev({ target }))!.target).toBeUndefined();
    }
    // ...but the event itself survives (action context is still useful).
    expect(sanitizeUiEvent(ev({ action: "login-page", target: "x.com/password" }))!.action).toBe("login-page");
  });

  it("truncates oversized targets", () => {
    const clean = sanitizeUiEvent(ev({ target: "x.com/" + "a".repeat(500) }));
    expect(clean!.target!.length).toBe(200);
  });
});

describe("ring bounds — LRU scopes + per-scope event cap", () => {
  it("evicts the oldest scope past MAX_UI_EVENT_SESSIONS and keeps MRU scopes", () => {
    const total = MAX_UI_EVENT_SESSIONS + 25;
    for (let i = 0; i < total; i++) {
      recordUiEvent(ev({ sessionId: `s${i}`, ts: i + 1 }));
      expect(uiEventScopeCount()).toBeLessThanOrEqual(MAX_UI_EVENT_SESSIONS);
    }
    expect(uiEventScopeCount()).toBe(MAX_UI_EVENT_SESSIONS);
    // Newest survives with its event; oldest was evicted (nothing fresh).
    expect(hasFreshUiEvents(`s${total - 1}`)).toBe(true);
    expect(hasFreshUiEvents("s0")).toBe(false);
  });

  it("caps events per scope at MAX_UI_EVENTS_PER_SESSION, keeping the newest", () => {
    const total = MAX_UI_EVENTS_PER_SESSION + 30;
    for (let i = 0; i < total; i++) {
      recordUiEvent(ev({ target: `x.com/p${i}`, ts: i + 1 }));
    }
    const digest = digestSince("s1", 0)!;
    // Oldest events fell off the ring: only the newest cap-worth remain.
    expect(digest.eventCount).toBe(MAX_UI_EVENTS_PER_SESSION);
    expect(digest.latestTs).toBe(total);
  });
});

describe("digestSince — formatting, dedupe, scoping", () => {
  it("collapses navigations into a chain and renders titles readably", () => {
    recordUiEvent(ev({ target: "x.com", ts: 1 }));
    recordUiEvent(ev({ target: "x.com/compose", ts: 2 }));
    recordUiEvent(ev({ action: "title", target: "Compose post", ts: 3 }));
    const digest = digestSince("s1", 0)!;
    expect(digest.text).toBe("Browser: user navigated x.com → x.com/compose; page title 'Compose post'");
    expect(digest.latestTs).toBe(3);
  });

  it("dedupes consecutive same-target events", () => {
    for (let i = 1; i <= 5; i++) recordUiEvent(ev({ target: "x.com", ts: i }));
    recordUiEvent(ev({ target: "x.com/next", ts: 6 }));
    expect(digestSince("s1", 0)!.text).toBe("Browser: user navigated x.com → x.com/next");
  });

  it("caps the digest at 4 lines (one per surface)", () => {
    for (const [i, surface] of ["browser", "editor", "terminal", "files", "voice"].entries()) {
      recordUiEvent(ev({ surface, action: "tab-open", target: undefined, ts: i + 1 }));
    }
    expect(digestSince("s1", 0)!.text.split("\n")).toHaveLength(4);
  });

  it("events without a session land in the global scope, visible to any session's digest", () => {
    recordUiEvent(ev({ sessionId: undefined, target: "news.ycombinator.com", ts: 5 }));
    expect(digestSince("some-session", 0)!.text).toContain("news.ycombinator.com");
    expect(digestSince("another-session", 0)!.text).toContain("news.ycombinator.com");
    expect(uiEventScopeCount()).toBe(1); // just the GLOBAL_UI_SCOPE ring
    expect(hasFreshUiEvents(GLOBAL_UI_SCOPE)).toBe(true);
  });

  it("a session's own events are NOT visible to other sessions", () => {
    recordUiEvent(ev({ sessionId: "mine", ts: 1 }));
    expect(digestSince("theirs", 0)).toBeNull();
  });
});

describe("freshness cursor — the same activity is never digested twice", () => {
  it("advanceDigestTs makes digestSince return null until new events arrive", () => {
    recordUiEvent(ev({ ts: 10 }));
    const first = digestSince("s1", getLastDigestTs("s1"))!;
    advanceDigestTs("s1", first.latestTs);
    expect(digestSince("s1", getLastDigestTs("s1"))).toBeNull();
    expect(hasFreshUiEvents("s1")).toBe(false);

    recordUiEvent(ev({ target: "x.com/new", ts: 11 }));
    expect(hasFreshUiEvents("s1")).toBe(true);
    expect(digestSince("s1", getLastDigestTs("s1"))!.text).toContain("x.com/new");
  });

  it("never rewinds the cursor", () => {
    advanceDigestTs("s1", 100);
    advanceDigestTs("s1", 50);
    expect(getLastDigestTs("s1")).toBe(100);
  });
});

describe("enableUiEventBus toggle — off means OFF at the store", () => {
  it("buffers nothing while disabled", () => {
    mock.config = { enableUiEventBus: false };
    recordUiEvent(ev());
    expect(uiEventScopeCount()).toBe(0);
    expect(digestSince("s1", 0)).toBeNull();
  });

  it("stops digesting already-buffered events when flipped off", () => {
    recordUiEvent(ev({ ts: 1 }));
    mock.config = { enableUiEventBus: false };
    expect(digestSince("s1", 0)).toBeNull();
    // Flipping back on restores the (still-buffered) activity.
    mock.config = { enableUiEventBus: true };
    expect(digestSince("s1", 0)).not.toBeNull();
  });
});
