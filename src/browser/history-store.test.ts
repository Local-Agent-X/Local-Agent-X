import { beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import {
  BrowserHistoryStore,
  HISTORY_CAP,
  sanitizeHistoryTitle,
  sanitizeHistoryUrl,
} from "./history-store.js";

function store(): BrowserHistoryStore {
  BrowserHistoryStore._resetForTest();
  return BrowserHistoryStore.getInstance();
}

beforeEach(() => {
  rmSync(join(getLaxDir(), "browser-history.json"), { force: true });
  BrowserHistoryStore._resetForTest();
});

describe("BrowserHistoryStore", () => {
  it("records newest-first, collapses consecutive duplicates, and persists", () => {
    const s = store();
    const first = s.recordVisit("https://example.com/a", "A")!;
    expect(s.recordVisit("https://example.com/a", "Updated")!.id).toBe(first.id);
    s.recordVisit("https://example.com/b", "B");
    expect(s.query().map((e) => e.title)).toEqual(["B", "Updated"]);
    expect(store().query()).toHaveLength(2);
  });

  it("searches url and title, honors limit, and removes or clears entries", () => {
    const s = store();
    const first = s.recordVisit("https://news.example.com/story", "Launch")!;
    s.recordVisit("https://vendor.example.com/pricing", "Pricing");
    expect(s.query({ q: "launch" })).toHaveLength(1);
    expect(s.query({ q: "example", limit: 1 })).toHaveLength(1);
    expect(s.remove(first.id)).toBe(true);
    expect(s.clear()).toBe(1);
  });

  it(`caps shared history at ${HISTORY_CAP} entries`, () => {
    const s = store();
    for (let i = 0; i < HISTORY_CAP + 3; i++) {
      s.recordVisit(`https://example.com/page-${i}`);
    }
    const rows = s.query({ limit: HISTORY_CAP + 10 });
    expect(rows).toHaveLength(HISTORY_CAP);
    expect(rows.some((e) => e.url.endsWith("/page-0"))).toBe(false);
  });

  it("redacts urls and credential-shaped titles", () => {
    const s = store();
    s.recordVisit("https://alice:secret@example.com/inbox?q=private", "Verification code 123456");
    expect(s.query()[0]).toMatchObject({ url: "https://example.com/inbox", title: "" });
    expect(sanitizeHistoryUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a");
    expect(sanitizeHistoryUrl("https://example.com/reset-password")).toBeNull();
    expect(sanitizeHistoryTitle("Inbox")).toBe("Inbox");
  });

  it("does not misattribute a title after dropping a sensitive visit", () => {
    const s = store();
    s.recordVisit("https://example.com/story", "Story");
    expect(s.recordVisit("https://example.com/reset-password")).toBeNull();
    s.touchTitle("Reset account");
    expect(s.query()[0].title).toBe("Story");
  });
});
