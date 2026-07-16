import { describe, it, expect, beforeEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";

// PRIVACY-LAW REUSE PROOF: the store must run urls through the ORCHESTRATOR'S
// redactTarget (imported), not a forked copy of the regexes. Wrapping the real
// function in a spy lets the privacy tests below assert both the behavior AND
// that the shared sanitizer was the thing invoked.
const spies = vi.hoisted(() => ({ redactTarget: vi.fn() }));
vi.mock("../orchestrator/ui-event-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../orchestrator/ui-event-store.js")>();
  spies.redactTarget.mockImplementation(actual.redactTarget);
  return { ...actual, redactTarget: spies.redactTarget };
});

import { getLaxDir } from "../lax-data-dir.js";
import { BrowserHistoryStore, HISTORY_CAP_PER_PROFILE, sanitizeHistoryUrl } from "./history-store.js";

function freshStore(): BrowserHistoryStore {
  BrowserHistoryStore._resetForTest();
  return BrowserHistoryStore.getInstance();
}

beforeEach(() => {
  rmSync(join(getLaxDir(), "browser-history.json"), { force: true });
  BrowserHistoryStore._resetForTest();
  spies.redactTarget.mockClear();
});

describe("recordVisit + query", () => {
  it("records a visit and returns it newest-first from query", () => {
    const store = freshStore();
    store.recordVisit("default", "https://example.com/a", "Page A");
    store.recordVisit("default", "https://example.com/b", "Page B");
    const out = store.query();
    expect(out.map((e) => e.url)).toEqual(["https://example.com/b", "https://example.com/a"]);
    expect(out[0].title).toBe("Page B");
    expect(out[0].profileId).toBe("default");
  });

  it("survives a singleton reset (persisted to disk)", () => {
    freshStore().recordVisit("work", "https://example.com/persist", "Persist");
    const reloaded = freshStore().query({ profileId: "work" });
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].url).toBe("https://example.com/persist");
  });

  it("substring-matches url AND title case-insensitively, honors profile filter + limit", () => {
    const store = freshStore();
    store.recordVisit("default", "https://news.example.com/story", "Big Launch");
    store.recordVisit("work", "https://vendor.example.com/pricing", "Pricing");
    store.recordVisit("work", "https://vendor.example.com/docs", "Docs");
    expect(store.query({ q: "LAUNCH" })).toHaveLength(1); // title match
    expect(store.query({ q: "vendor" })).toHaveLength(2); // url match
    expect(store.query({ profileId: "work" })).toHaveLength(2);
    expect(store.query({ profileId: "work", limit: 1 })).toHaveLength(1);
  });

  it("collapses a consecutive duplicate url into the prior row (ts/title refresh, no new row)", () => {
    const store = freshStore();
    const first = store.recordVisit("default", "https://example.com/x", "");
    const collapsed = store.recordVisit("default", "https://example.com/x", "Now titled");
    expect(collapsed!.id).toBe(first!.id);
    expect(store.query()).toHaveLength(1);
    expect(store.query()[0].title).toBe("Now titled");
    // Not consecutive anymore → a fresh row.
    store.recordVisit("default", "https://example.com/y", "");
    store.recordVisit("default", "https://example.com/x", "");
    expect(store.query()).toHaveLength(3);
  });

  it("dup-collapse is PER PROFILE — another profile's identical url is its own row", () => {
    const store = freshStore();
    store.recordVisit("default", "https://example.com/shared", "");
    store.recordVisit("work", "https://example.com/shared", "");
    expect(store.query()).toHaveLength(2);
  });

  it(`caps each profile at ${HISTORY_CAP_PER_PROFILE} entries, evicting oldest, other profiles untouched`, () => {
    const store = freshStore();
    store.recordVisit("other", "https://keep.example.com/me", "");
    for (let i = 0; i < HISTORY_CAP_PER_PROFILE + 5; i++) {
      store.recordVisit("default", `https://example.com/page-${i}`, "");
    }
    const defaults = store.query({ profileId: "default", limit: HISTORY_CAP_PER_PROFILE + 10 });
    expect(defaults).toHaveLength(HISTORY_CAP_PER_PROFILE);
    // Oldest five evicted; newest survives.
    expect(defaults.some((e) => e.url.endsWith("/page-0"))).toBe(false);
    expect(defaults.some((e) => e.url.endsWith("/page-4"))).toBe(false);
    expect(defaults[0].url.endsWith(`/page-${HISTORY_CAP_PER_PROFILE + 4}`)).toBe(true);
    expect(store.query({ profileId: "other" })).toHaveLength(1);
  });
});

describe("privacy law (via the IMPORTED redactTarget — see mock above)", () => {
  it("strips query strings, fragments, and URL userinfo before storing", () => {
    const store = freshStore();
    store.recordVisit("default", "https://example.com/search?q=my+ssn#frag", "");
    store.recordVisit("default", "https://alice:hunter2@example.com/inbox", "");
    const urls = store.query().map((e) => e.url);
    expect(urls).toContain("https://example.com/search");
    expect(urls).toContain("https://example.com/inbox");
    for (const u of urls) {
      expect(u).not.toMatch(/[?#]/);
      expect(u).not.toContain("hunter2");
      expect(u).not.toContain("@");
    }
  });

  it("DROPS credential-shaped urls entirely", () => {
    const store = freshStore();
    expect(store.recordVisit("default", "https://example.com/reset-password/step2", "")).toBeNull();
    expect(store.recordVisit("default", "https://example.com/api_key/rotate", "")).toBeNull();
    expect(store.query()).toHaveLength(0);
  });

  it("every stored url went through the orchestrator's redactTarget (import reuse, not a copy)", () => {
    const store = freshStore();
    spies.redactTarget.mockClear();
    store.recordVisit("default", "https://example.com/a?tracking=1", "");
    store.recordVisit("default", "https://example.com/password-reset", "");
    expect(spies.redactTarget).toHaveBeenCalledTimes(2);
    expect(spies.redactTarget).toHaveBeenCalledWith("https://example.com/a?tracking=1");
  });

  it("sanitizeHistoryUrl mirrors redactTarget verdicts", () => {
    expect(sanitizeHistoryUrl("https://example.com/a?b=1")).toBe("https://example.com/a");
    expect(sanitizeHistoryUrl("https://example.com/login?token=abc#x")).toBe("https://example.com/login");
    expect(sanitizeHistoryUrl("https://example.com/my-password-vault")).toBeNull();
    expect(sanitizeHistoryUrl("")).toBeNull();
  });
});

describe("remove + clear", () => {
  it("removes one entry by id; unknown id is a no-op false", () => {
    const store = freshStore();
    const e = store.recordVisit("default", "https://example.com/z", "")!;
    expect(store.remove("hist-nope")).toBe(false);
    expect(store.remove(e.id)).toBe(true);
    expect(store.query()).toHaveLength(0);
  });

  it("clear() wipes everything; clear(profileId) wipes only that profile", () => {
    const store = freshStore();
    store.recordVisit("default", "https://example.com/1", "");
    store.recordVisit("work", "https://example.com/2", "");
    expect(store.clear("work")).toBe(1);
    expect(store.query({ profileId: "default" })).toHaveLength(1);
    expect(store.clear()).toBe(1);
    expect(store.query()).toHaveLength(0);
  });
});
