import { describe, it, expect, beforeEach } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { BrowserBookmarkStore } from "./bookmark-store.js";

function freshStore(): BrowserBookmarkStore {
  BrowserBookmarkStore._resetForTest();
  return BrowserBookmarkStore.getInstance();
}

beforeEach(() => {
  rmSync(join(getLaxDir(), "browser-bookmarks.json"), { force: true });
  BrowserBookmarkStore._resetForTest();
});

describe("BrowserBookmarkStore", () => {
  it("adds a bookmark with the full shape and round-trips it across a reset", () => {
    const store = freshStore();
    const bm = store.add({ url: "https://example.com/docs", title: "Docs", tags: ["ref"], profileId: "work", addedBy: "agent" });
    expect(bm.id).toMatch(/^bm-/);
    expect(bm.addedBy).toBe("agent");
    expect(bm.tags).toEqual(["ref"]);
    expect(bm.profileId).toBe("work");
    const reloaded = freshStore().get(bm.id);
    expect(reloaded?.url).toBe("https://example.com/docs");
    expect(reloaded?.title).toBe("Docs");
  });

  it("dedupes by url — re-add updates title/tags, keeps id/addedBy/ts", () => {
    const store = freshStore();
    const first = store.add({ url: "https://example.com/x", title: "Old", addedBy: "user" });
    const again = store.add({ url: "https://example.com/x", title: "New", tags: ["a", "b"], addedBy: "agent" });
    expect(again.id).toBe(first.id);
    expect(again.addedBy).toBe("user"); // identity preserved
    expect(again.ts).toBe(first.ts);
    expect(again.title).toBe("New");
    expect(again.tags).toEqual(["a", "b"]);
    expect(store.list()).toHaveLength(1);
  });

  it("re-add without title/tags leaves the existing values alone", () => {
    const store = freshStore();
    store.add({ url: "https://example.com/keep", title: "Keep me", tags: ["t"], addedBy: "user" });
    const again = store.add({ url: "https://example.com/keep", addedBy: "agent" });
    expect(again.title).toBe("Keep me");
    expect(again.tags).toEqual(["t"]);
  });

  it("strips URL userinfo (credentials never land in the shared list)", () => {
    const bm = freshStore().add({ url: "https://alice:hunter2@example.com/page?keep=1", addedBy: "user" });
    expect(bm.url).toBe("https://example.com/page?keep=1"); // query KEPT — bookmarks need it
    expect(bm.url).not.toContain("hunter2");
  });

  it("rejects an empty url", () => {
    expect(() => freshStore().add({ url: "   ", addedBy: "user" })).toThrowError(/url is required/);
  });

  it("list() is newest-first and filters on url/title/tags substring + profile", () => {
    const store = freshStore();
    store.add({ url: "https://a.example.com/", title: "Alpha", tags: ["daily"], addedBy: "user" });
    store.add({ url: "https://b.example.com/", title: "Beta", profileId: "work", addedBy: "agent" });
    expect(store.list().map((b) => b.title)).toEqual(["Beta", "Alpha"]);
    expect(store.list({ q: "daily" })).toHaveLength(1); // tag match
    expect(store.list({ q: "b.example" })).toHaveLength(1); // url match
    expect(store.list({ profileId: "work" }).map((b) => b.title)).toEqual(["Beta"]);
  });

  it("remove() deletes by id and returns false for unknown ids", () => {
    const store = freshStore();
    const bm = store.add({ url: "https://example.com/rm", addedBy: "user" });
    expect(store.remove("bm-nope")).toBe(false);
    expect(store.remove(bm.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
  });
});
