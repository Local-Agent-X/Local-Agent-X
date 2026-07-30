import { beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { BrowserBookmarkStore, scrubCredentialParams } from "./bookmark-store.js";

beforeEach(() => {
  rmSync(join(getLaxDir(), "browser-bookmarks.json"), { force: true });
  BrowserBookmarkStore._resetForTest();
});

describe("BrowserBookmarkStore", () => {
  it("adds, persists, lists, and removes shared bookmarks", () => {
    const store = BrowserBookmarkStore.getInstance();
    const bm = store.add({ url: "https://example.com/docs", title: "Docs", tags: ["ref"], addedBy: "agent" });
    expect(store.list()[0]).toMatchObject({ title: "Docs", addedBy: "agent", tags: ["ref"] });
    BrowserBookmarkStore._resetForTest();
    expect(BrowserBookmarkStore.getInstance().get(bm.id)).not.toBeNull();
    expect(BrowserBookmarkStore.getInstance().remove(bm.id)).toBe(true);
  });

  it("deduplicates by url and filters by content", () => {
    const store = BrowserBookmarkStore.getInstance();
    const first = store.add({ url: "https://example.com/a", title: "Old", addedBy: "user" });
    const again = store.add({ url: "https://example.com/a", title: "New", tags: ["daily"], addedBy: "agent" });
    expect(again.id).toBe(first.id);
    expect(again.addedBy).toBe("user");
    expect(store.list({ q: "daily" })).toHaveLength(1);
  });

  it("strips userinfo and credential parameters", () => {
    const bm = BrowserBookmarkStore.getInstance().add({
      url: "https://alice:secret@example.com/watch?v=1&session_token=SECRET",
      addedBy: "user",
    });
    expect(bm.url).toBe("https://example.com/watch?v=1");
    expect(scrubCredentialParams("https://x.test/#access_token=SECRET&state=1"))
      .toBe("https://x.test/#state=1");
  });
});
