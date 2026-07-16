import { describe, it, expect, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../../lax-data-dir.js";
import { BrowserHistoryStore } from "../../browser/history-store.js";
import { BrowserBookmarkStore } from "../../browser/bookmark-store.js";
import type { BrowserBackend } from "../../browser/index.js";
import { handleHistory, handleBookmarkAdd, handleBookmarks } from "./library.js";
import { BROWSER_TOOL_PARAMETERS, BROWSER_TOOL_DESCRIPTION } from "./description.js";
import { createBrowserTools } from "./index.js";

function fakeManager(over: Partial<Record<keyof BrowserBackend, unknown>> = {}): BrowserBackend {
  return {
    getProfileId: () => "work",
    getCurrentUrl: () => "https://example.com/current",
    getInfo: async () => "Browser active\nEngine: chromium\nURL: https://example.com/current\nTitle: Current Page",
    ...over,
  } as unknown as BrowserBackend;
}

beforeEach(() => {
  rmSync(join(getLaxDir(), "browser-history.json"), { force: true });
  rmSync(join(getLaxDir(), "browser-bookmarks.json"), { force: true });
  BrowserHistoryStore._resetForTest();
  BrowserBookmarkStore._resetForTest();
});

describe("history action", () => {
  it("lists newest-first across ALL profiles, honoring find + limit", () => {
    const store = BrowserHistoryStore.getInstance();
    store.recordVisit("default", "https://news.example.com/story", "Launch Day");
    store.recordVisit("work", "https://vendor.example.com/pricing", "Pricing");

    const all = handleHistory({});
    expect(all.isError).toBeFalsy();
    expect(all.content).toContain("newest first");
    // Cross-profile: user (default) rows visible to the agent and vice versa.
    expect(all.content).toContain("news.example.com/story");
    expect(all.content).toContain("vendor.example.com/pricing");
    // "story" alone would collide with the word "history" in the header —
    // compare full urls.
    expect(all.content.indexOf("vendor.example.com/pricing"))
      .toBeLessThan(all.content.indexOf("news.example.com/story"));

    const found = handleHistory({ find: "launch" });
    expect(found.content).toContain("Launch Day");
    expect(found.content).not.toContain("Pricing");

    const capped = handleHistory({ limit: 1 });
    expect(capped.content).toContain("1 entry");
  });

  it("says so when history is empty or nothing matches", () => {
    expect(handleHistory({}).content).toContain("empty");
    BrowserHistoryStore.getInstance().recordVisit("default", "https://example.com/a", "");
    expect(handleHistory({ find: "zzz-no-match" }).content).toContain('No history entries match "zzz-no-match"');
  });
});

describe("bookmark_add action", () => {
  it("defaults to the ACTIVE page: url from getCurrentUrl, title parsed from getInfo", async () => {
    const r = await handleBookmarkAdd(fakeManager(), {});
    expect(r.isError).toBeFalsy();
    const [bm] = BrowserBookmarkStore.getInstance().list();
    expect(bm.url).toBe("https://example.com/current");
    expect(bm.title).toBe("Current Page");
    expect(bm.addedBy).toBe("agent");
    expect(bm.profileId).toBe("work");
  });

  it("explicit url/title win over the active page", async () => {
    await handleBookmarkAdd(fakeManager(), { url: "https://other.example.com/", title: "Other" });
    const [bm] = BrowserBookmarkStore.getInstance().list();
    expect(bm.url).toBe("https://other.example.com/");
    expect(bm.title).toBe("Other");
  });

  it("errors when there is no url and no open page", async () => {
    const r = await handleBookmarkAdd(fakeManager({ getCurrentUrl: () => "" }), {});
    expect(r.isError).toBe(true);
    expect(BrowserBookmarkStore.getInstance().list()).toHaveLength(0);
  });
});

describe("bookmarks action", () => {
  it("lists shared bookmarks with find filter", () => {
    const store = BrowserBookmarkStore.getInstance();
    store.add({ url: "https://a.example.com/", title: "Alpha", addedBy: "user" });
    store.add({ url: "https://b.example.com/", title: "Beta", tags: ["daily"], addedBy: "agent" });
    const all = handleBookmarks({});
    expect(all.content).toContain("Alpha");
    expect(all.content).toContain("Beta");
    expect(all.content).toContain("shared");
    const filtered = handleBookmarks({ find: "daily" });
    expect(filtered.content).toContain("Beta");
    expect(filtered.content).not.toContain("Alpha");
  });

  it("says so when there are none", () => {
    expect(handleBookmarks({}).content).toContain("No bookmarks");
  });
});

describe("3-place sync: enum, prose, read-only classification", () => {
  it("the parameters enum and the prose both carry all three actions", () => {
    const actions = (BROWSER_TOOL_PARAMETERS.properties.action as { enum: string[] }).enum;
    for (const a of ["history", "bookmark_add", "bookmarks"]) {
      expect(actions).toContain(a);
      expect(BROWSER_TOOL_DESCRIPTION).toContain(`- ${a}:`);
    }
  });

  it("history/bookmarks classify read-only; bookmark_add stays non-idempotent", () => {
    const [tool] = createBrowserTools(() => "test-session");
    const effect = tool.effect as (args: Record<string, unknown>) => { class: string };
    expect(effect({ action: "history" })).toEqual({ class: "read-only" });
    expect(effect({ action: "bookmarks" })).toEqual({ class: "read-only" });
    expect(effect({ action: "bookmark_add" })).toEqual({ class: "non-idempotent" });
  });
});

describe("bookmark_add sensitive-page gate (skeptic regression)", () => {
  it("is blocked on secret-bearing pages like the other secret-reading actions", async () => {
    const { sensitivePageActionDecision } = await import("../../browser/guards.js");
    expect(sensitivePageActionDecision("https://vault.bitwarden.com/passwords", "bookmark_add").disposition).toBe("blocked");
    expect(sensitivePageActionDecision("https://example.com/account-recovery/start", "bookmark_add").disposition).toBe("blocked");
    // Ordinary pages stay bookmarkable.
    expect(sensitivePageActionDecision("https://news.ycombinator.com/", "bookmark_add").disposition).toBe("allow");
  });
});
