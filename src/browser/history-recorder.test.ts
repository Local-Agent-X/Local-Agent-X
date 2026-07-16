import { describe, it, expect, beforeEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../event-bus.js";

// Live-toggle mock, same pattern as signals-ui-events.test.ts — the flag must
// be swappable mid-test. Only getRuntimeConfig is overridden.
const mock = vi.hoisted(() => ({
  config: { enableUiEventBus: true } as { enableUiEventBus: boolean },
  warn: vi.fn(),
}));
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, getRuntimeConfig: () => mock.config };
});
vi.mock("../logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: mock.warn, error: vi.fn(), debug: vi.fn() }),
}));

import { getLaxDir } from "../lax-data-dir.js";
import { BrowserHistoryStore } from "./history-store.js";
import { registerSessionOwner, _resetSessionOwnerRegistry } from "./session-owner-registry.js";
import { _rewireHistoryRecorderForTest, recordAgentVisit } from "./history-recorder.js";

beforeEach(() => {
  mock.config = { enableUiEventBus: true };
  mock.warn.mockClear();
  rmSync(join(getLaxDir(), "browser-history.json"), { force: true });
  BrowserHistoryStore._resetForTest();
  _resetSessionOwnerRegistry();
  _rewireHistoryRecorderForTest();
});

const store = (): BrowserHistoryStore => BrowserHistoryStore.getInstance();

describe("bus → history recording", () => {
  it("records a session navigate under the session's RESOLVED browser profile", async () => {
    registerSessionOwner("sess-1", { browserProfileId: "work" });
    await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "https://example.com/run", sessionId: "sess-1", ts: Date.now() });
    const rows = store().query({ profileId: "work" });
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://example.com/run");
  });

  it("global-scope events (no sessionId — user views) record under 'default'", async () => {
    await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "https://example.com/user", ts: Date.now() });
    const rows = store().query({ profileId: "default" });
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://example.com/user");
  });

  it("an unregistered session falls back to the default profile (registry contract)", async () => {
    await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "https://example.com/anon", sessionId: "never-registered", ts: Date.now() });
    expect(store().query({ profileId: "default" })).toHaveLength(1);
  });

  it("a follow-up title event stamps the latest entry's title", async () => {
    await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "https://example.com/story", ts: Date.now() });
    await EventBus.emit("ui:browser", { surface: "browser", action: "title", target: "The Story", ts: Date.now() });
    expect(store().query()[0].title).toBe("The Story");
  });

  it("ignores non-navigate/title actions and shapeless payloads", async () => {
    await EventBus.emit("ui:browser", { surface: "browser", action: "login-page", target: "https://example.com/", ts: Date.now() });
    await EventBus.emit("ui:browser", "just a string");
    await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", ts: Date.now() }); // no target
    expect(store().query()).toHaveLength(0);
  });

  it("re-wiring never stacks listeners (one event → one row)", async () => {
    _rewireHistoryRecorderForTest();
    _rewireHistoryRecorderForTest();
    await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "https://example.com/once", ts: Date.now() });
    expect(store().query()).toHaveLength(1);
  });
});

describe("enableUiEventBus toggle", () => {
  it("toggle off ⇒ no rows recorded; back on ⇒ recording resumes (live, no re-wire)", async () => {
    mock.config = { enableUiEventBus: false };
    await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "https://example.com/off", ts: Date.now() });
    expect(store().query()).toHaveLength(0);
    mock.config = { enableUiEventBus: true };
    await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "https://example.com/on", ts: Date.now() });
    expect(store().query()).toHaveLength(1);
  });
});

describe("write-failure posture", () => {
  it("a throwing store warns ONCE and never throws into the bus handler", async () => {
    const boom = vi.spyOn(BrowserHistoryStore.prototype, "recordVisit").mockImplementation(() => { throw new Error("disk full"); });
    try {
      await expect(
        EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "https://example.com/1", ts: Date.now() }),
      ).resolves.toBeUndefined();
      await EventBus.emit("ui:browser", { surface: "browser", action: "navigate", target: "https://example.com/2", ts: Date.now() });
      expect(mock.warn).toHaveBeenCalledTimes(1);
      expect(String(mock.warn.mock.calls[0][0])).toContain("history write failed");
    } finally {
      boom.mockRestore();
    }
  });
});

describe("recordAgentVisit (deferred agent-tab seam)", () => {
  it("records directly under the given profile, defaulting empty to 'default'", () => {
    recordAgentVisit("work", "https://example.com/agent", "Agent Page");
    recordAgentVisit("", "https://example.com/fallback");
    expect(store().query({ profileId: "work" })[0].title).toBe("Agent Page");
    expect(store().query({ profileId: "default" })).toHaveLength(1);
  });

  it("also warns instead of throwing on store failure", () => {
    const boom = vi.spyOn(BrowserHistoryStore.prototype, "recordVisit").mockImplementation(() => { throw new Error("disk full"); });
    try {
      expect(() => recordAgentVisit("default", "https://example.com/x")).not.toThrow();
      expect(mock.warn).toHaveBeenCalledTimes(1);
    } finally {
      boom.mockRestore();
    }
  });
});
