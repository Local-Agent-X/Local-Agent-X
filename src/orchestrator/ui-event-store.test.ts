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
  UI_DIGEST_TTL_MS,
  _resetUiEventStoreForTest,
  hasFreshUiEvents,
  recentUiDigest,
  recordUiEvent,
  redactTarget,
  sanitizeUiEvent,
  uiEventScopeCount,
  type UiEvent,
} from "./ui-event-store.js";

// A fixed "now" so TTL windows are deterministic; event ts values are
// offsets close beneath it.
const NOW = 1_750_000_000_000;
const t = (offsetMs: number): number => NOW - offsetMs;

function ev(overrides: Partial<UiEvent> & Record<string, unknown> = {}): UiEvent {
  return { surface: "browser", action: "navigate", target: "x.com", sessionId: "s1", ts: t(1000), ...overrides } as UiEvent;
}

/** Digest text without the variable `[n ui events, latest hh:mm:ss] ` prefix. */
function body(text: string): string {
  return text.replace(/^\[\d+ ui events, latest \d\d:\d\d:\d\d\] /, "");
}

beforeEach(() => {
  mock.config = { enableUiEventBus: true };
  _resetUiEventStoreForTest();
});

describe("sanitizeUiEvent — the schema is a law of the store", () => {
  it("strips fields outside the pinned schema", () => {
    const clean = sanitizeUiEvent({ ...ev(), password: "hunter2", extra: { deep: true } });
    expect(clean).toEqual({ surface: "browser", action: "navigate", target: "x.com", sessionId: "s1", ts: t(1000) });
    expect(Object.keys(clean!).sort()).toEqual(["action", "sessionId", "surface", "target", "ts"]);
  });

  it("rejects non-objects and events missing surface/action", () => {
    expect(sanitizeUiEvent(null)).toBeNull();
    expect(sanitizeUiEvent("ui:browser")).toBeNull();
    expect(sanitizeUiEvent({ action: "navigate", ts: 1 })).toBeNull();
    expect(sanitizeUiEvent({ surface: "browser", action: "", ts: 1 })).toBeNull();
    expect(sanitizeUiEvent({ surface: 42, action: "navigate", ts: 1 })).toBeNull();
  });

  it("rejects events whose surface/action are not plain labels (value smuggling)", () => {
    // '=', ':', '@' are the characters every key=value / token smuggle needs.
    expect(sanitizeUiEvent(ev({ action: "autofill value=hunter2" }))).toBeNull();
    expect(sanitizeUiEvent(ev({ action: "token: abc123" }))).toBeNull();
    expect(sanitizeUiEvent(ev({ surface: "browser@evil" }))).toBeNull();
    // Legitimate labels survive, including ones NAMING sensitive concepts.
    expect(sanitizeUiEvent(ev({ action: "login-page" }))!.action).toBe("login-page");
    expect(sanitizeUiEvent(ev({ action: "password-field focus" }))!.action).toBe("password-field focus");
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

  it("strips URL userinfo — a password in the authority NEVER survives", () => {
    expect(redactTarget("https://alice:hunter2@example.com/dashboard")).toBe("https://example.com/dashboard");
    expect(redactTarget("//alice:hunter2@example.com/a")).toBe("//example.com/a");
    expect(redactTarget("alice:hunter2@example.com/a")).toBe("example.com/a");
    // '@' after the first slash is content (e.g. a profile path), not userinfo.
    expect(redactTarget("x.com/@handle")).toBe("x.com/@handle");
    const viaEvent = sanitizeUiEvent(ev({ target: "https://alice:hunter2@example.com/dashboard" }));
    expect(viaEvent!.target).not.toContain("hunter2");
  });

  it("elides opaque token-shaped path segments (JWTs, hex digests, long ids)", () => {
    expect(redactTarget("example.com/session/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0")).toBe("example.com/session/…");
    expect(redactTarget("example.com/reset/4f2a9c81b7e3d605aa218c44")).toBe("example.com/reset/…");
    // Ordinary long WORDS without digits are kept (product names, slugs).
    expect(redactTarget("example.com/internationalization-notes")).toBe("example.com/internationalization-notes");
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

describe("ring bounds — LRU scopes + per-scope event cap + pinned global", () => {
  it("evicts the oldest scope past MAX_UI_EVENT_SESSIONS and keeps MRU scopes", () => {
    const total = MAX_UI_EVENT_SESSIONS + 25;
    for (let i = 0; i < total; i++) {
      recordUiEvent(ev({ sessionId: `s${i}`, ts: t(1000) }));
      expect(uiEventScopeCount()).toBeLessThanOrEqual(MAX_UI_EVENT_SESSIONS);
    }
    expect(uiEventScopeCount()).toBe(MAX_UI_EVENT_SESSIONS);
    expect(hasFreshUiEvents(`s${total - 1}`, NOW)).toBe(true);
    expect(hasFreshUiEvents("s0", NOW)).toBe(false);
  });

  it("never evicts the global scope, even under scope flood", () => {
    recordUiEvent(ev({ sessionId: undefined, target: "shared.example", ts: t(500) }));
    for (let i = 0; i < MAX_UI_EVENT_SESSIONS + 40; i++) {
      recordUiEvent(ev({ sessionId: `flood${i}`, ts: t(400) }));
    }
    // The flood filled the table, but the shared context survived.
    expect(recentUiDigest("some-session", NOW)!.text).toContain("shared.example");
  });

  it("reading a digest MRU-touches the session so active conversations aren't evicted", () => {
    recordUiEvent(ev({ sessionId: "active", target: "keep.me", ts: t(900) }));
    // Make "active" the oldest scope, then interleave reads with a flood.
    for (let i = 0; i < MAX_UI_EVENT_SESSIONS - 1; i++) {
      recordUiEvent(ev({ sessionId: `f${i}`, ts: t(800) }));
      if (i % 50 === 0) expect(recentUiDigest("active", NOW)).not.toBeNull(); // touch
    }
    for (let i = 0; i < 60; i++) {
      recordUiEvent(ev({ sessionId: `g${i}`, ts: t(700) }));
      if (i % 10 === 0) recentUiDigest("active", NOW); // keep touching through the overflow
    }
    expect(recentUiDigest("active", NOW)!.text).toContain("keep.me");
  });

  it("caps events per scope at MAX_UI_EVENTS_PER_SESSION, keeping the newest", () => {
    const total = MAX_UI_EVENTS_PER_SESSION + 30;
    for (let i = 0; i < total; i++) {
      recordUiEvent(ev({ target: `x.com/p${i}`, ts: t(10_000) + i }));
    }
    const digest = recentUiDigest("s1", NOW)!;
    expect(digest.eventCount).toBe(MAX_UI_EVENTS_PER_SESSION);
    expect(digest.latestTs).toBe(t(10_000) + total - 1);
  });
});

describe("recentUiDigest — formatting, dedupe, scoping, TTL window", () => {
  it("collapses navigations into a chain, renders titles, and prefixes the window identity", () => {
    recordUiEvent(ev({ target: "x.com", ts: t(3000) }));
    recordUiEvent(ev({ target: "x.com/compose", ts: t(2000) }));
    recordUiEvent(ev({ action: "title", target: "Compose post", ts: t(1000) }));
    const digest = recentUiDigest("s1", NOW)!;
    expect(digest.text).toMatch(/^\[3 ui events, latest \d\d:\d\d:\d\d\] /);
    expect(body(digest.text)).toBe("Browser: user navigated x.com → x.com/compose; page title 'Compose post'");
    expect(digest.latestTs).toBe(t(1000));
  });

  it("the prefix changes when (and only when) the window's events change — the pipeline's 40-char hash sees new activity", () => {
    recordUiEvent(ev({ target: "github.com/anthropics/claude-code/pulls", ts: t(5000) }));
    const first = recentUiDigest("s1", NOW)!.text;
    const repeat = recentUiDigest("s1", NOW)!.text;
    expect(repeat).toBe(first); // identical window ⇒ identical text ⇒ dedupe is CORRECT
    recordUiEvent(ev({ target: "github.com/anthropics/claude-code/issues", ts: t(1000) }));
    const changed = recentUiDigest("s1", NOW)!.text;
    // Same-site continuation must differ within the first 40 chars (hash window).
    expect(changed.slice(0, 40)).not.toBe(first.slice(0, 40));
  });

  it("activity older than the TTL falls out of the window", () => {
    recordUiEvent(ev({ target: "old.example", ts: NOW - UI_DIGEST_TTL_MS - 1 }));
    expect(recentUiDigest("s1", NOW)).toBeNull();
    expect(hasFreshUiEvents("s1", NOW)).toBe(false);
    recordUiEvent(ev({ target: "new.example", ts: t(1) }));
    const digest = recentUiDigest("s1", NOW)!;
    expect(digest.text).toContain("new.example");
    expect(digest.text).not.toContain("old.example");
  });

  it("a downstream drop loses nothing — the same window digests again next turn", () => {
    recordUiEvent(ev({ target: "x.com/compose", ts: t(2000) }));
    const attempt1 = recentUiDigest("s1", NOW);
    const attempt2 = recentUiDigest("s1", NOW + 30_000); // next turn, still in window
    expect(attempt1).not.toBeNull();
    expect(attempt2).not.toBeNull();
    expect(body(attempt2!.text)).toBe(body(attempt1!.text));
  });

  it("dedupes consecutive same-target events", () => {
    for (let i = 1; i <= 5; i++) recordUiEvent(ev({ target: "x.com", ts: t(6000) + i }));
    recordUiEvent(ev({ target: "x.com/next", ts: t(1000) }));
    expect(body(recentUiDigest("s1", NOW)!.text)).toBe("Browser: user navigated x.com → x.com/next");
  });

  it("caps the digest at 4 surface lines", () => {
    for (const [i, surface] of ["browser", "editor", "terminal", "files", "voice"].entries()) {
      recordUiEvent(ev({ surface, action: "tab-open", target: undefined, ts: t(1000) + i }));
    }
    expect(recentUiDigest("s1", NOW)!.text.split("\n")).toHaveLength(4);
  });

  it("events without a session land in the global scope, visible to any session's digest", () => {
    recordUiEvent(ev({ sessionId: undefined, target: "news.ycombinator.com", ts: t(500) }));
    expect(recentUiDigest("some-session", NOW)!.text).toContain("news.ycombinator.com");
    expect(recentUiDigest("another-session", NOW)!.text).toContain("news.ycombinator.com");
    expect(uiEventScopeCount()).toBe(1); // just the GLOBAL_UI_SCOPE ring
    expect(hasFreshUiEvents(GLOBAL_UI_SCOPE, NOW)).toBe(true);
  });

  it("a session's own events are NOT visible to other sessions", () => {
    recordUiEvent(ev({ sessionId: "mine", ts: t(500) }));
    expect(recentUiDigest("theirs", NOW)).toBeNull();
  });
});

describe("enableUiEventBus toggle — off means OFF at the store", () => {
  it("buffers nothing while disabled", () => {
    mock.config = { enableUiEventBus: false };
    recordUiEvent(ev());
    expect(uiEventScopeCount()).toBe(0);
    expect(recentUiDigest("s1", NOW)).toBeNull();
  });

  it("stops digesting already-buffered events when flipped off", () => {
    recordUiEvent(ev({ ts: t(500) }));
    mock.config = { enableUiEventBus: false };
    expect(recentUiDigest("s1", NOW)).toBeNull();
    // Flipping back on restores the (still-buffered) activity.
    mock.config = { enableUiEventBus: true };
    expect(recentUiDigest("s1", NOW)).not.toBeNull();
  });
});
