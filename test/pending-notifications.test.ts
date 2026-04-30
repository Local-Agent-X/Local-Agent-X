import { describe, it, expect, vi, afterEach } from "vitest";
import {
  pushPendingNotification,
  drainPendingNotifications,
  findRecentCompletionMatching,
  findAnyRecentCompletion,
  formatNotificationsForSystemPrompt,
  PendingNotification,
} from "../src/workers/pending-notifications.js";

// Module state is a singleton; isolate by unique sessionIds per test.
let counter = 0;
const sid = (label: string) => `t${Date.now()}-${++counter}-${label}`;

const mkNote = (over: Partial<PendingNotification> = {}): PendingNotification => ({
  opId: over.opId ?? `op-${++counter}`,
  status: over.status ?? "completed",
  summary: over.summary ?? "did the thing",
  filesChanged: over.filesChanged ?? [],
  task: over.task ?? "do the thing please now",
  completedAt: over.completedAt ?? Date.now(),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pushPendingNotification + drainPendingNotifications", () => {
  it("returns empty array for unknown session", () => {
    expect(drainPendingNotifications(sid("empty"))).toEqual([]);
  });

  it("ignores empty sessionId on push and drain", () => {
    pushPendingNotification("", mkNote());
    expect(drainPendingNotifications("")).toEqual([]);
  });

  it("push then drain returns the notification and clears the queue", () => {
    const s = sid("a");
    const n = mkNote({ opId: "op-A" });
    pushPendingNotification(s, n);
    const drained = drainPendingNotifications(s);
    expect(drained).toHaveLength(1);
    expect(drained[0].opId).toBe("op-A");
    expect(drainPendingNotifications(s)).toEqual([]);
  });

  it("partitions queues by session", () => {
    const sa = sid("partA");
    const sb = sid("partB");
    pushPendingNotification(sa, mkNote({ opId: "op-A" }));
    pushPendingNotification(sb, mkNote({ opId: "op-B" }));
    const da = drainPendingNotifications(sa);
    const db = drainPendingNotifications(sb);
    expect(da.map(n => n.opId)).toEqual(["op-A"]);
    expect(db.map(n => n.opId)).toEqual(["op-B"]);
  });

  it("filters TTL-expired notifications on drain", () => {
    const s = sid("ttl");
    const stale = mkNote({ opId: "stale", completedAt: Date.now() - 25 * 60 * 60 * 1000 });
    const fresh = mkNote({ opId: "fresh" });
    pushPendingNotification(s, stale);
    pushPendingNotification(s, fresh);
    const drained = drainPendingNotifications(s);
    expect(drained.map(n => n.opId)).toEqual(["fresh"]);
  });

  it("caps queue at MAX_PER_SESSION (20) — older entries drop first", () => {
    const s = sid("cap");
    for (let i = 0; i < 25; i++) {
      pushPendingNotification(s, mkNote({ opId: `op-${i}` }));
    }
    const drained = drainPendingNotifications(s);
    expect(drained).toHaveLength(20);
    expect(drained[0].opId).toBe("op-5");
    expect(drained[19].opId).toBe("op-24");
  });

  it("preserves push order in the drain output", () => {
    const s = sid("order");
    pushPendingNotification(s, mkNote({ opId: "first" }));
    pushPendingNotification(s, mkNote({ opId: "second" }));
    pushPendingNotification(s, mkNote({ opId: "third" }));
    const drained = drainPendingNotifications(s);
    expect(drained.map(n => n.opId)).toEqual(["first", "second", "third"]);
  });
});

describe("findRecentCompletionMatching", () => {
  it("returns null when there is no history", () => {
    expect(findRecentCompletionMatching(sid("empty"), "build something")).toBeNull();
  });

  it("returns null for empty sessionId or candidate", () => {
    expect(findRecentCompletionMatching("", "build something long enough")).toBeNull();
    expect(findRecentCompletionMatching(sid("x"), "")).toBeNull();
  });

  it("matches when candidate is a substring of prior task (target ⊂ prior)", () => {
    const s = sid("sub1");
    pushPendingNotification(s, mkNote({ task: "build the homepage hero section" }));
    const hit = findRecentCompletionMatching(s, "build the homepage");
    expect(hit).not.toBeNull();
    expect(hit!.task).toContain("homepage");
  });

  it("matches when prior task is a substring of candidate (prior ⊂ target)", () => {
    const s = sid("sub2");
    pushPendingNotification(s, mkNote({ task: "build the homepage" }));
    const hit = findRecentCompletionMatching(s, "build the homepage with hero section");
    expect(hit).not.toBeNull();
  });

  it("normalizes whitespace and casing before comparing", () => {
    const s = sid("norm");
    pushPendingNotification(s, mkNote({ task: "Build   The   Homepage   Hero" }));
    const hit = findRecentCompletionMatching(s, "build the homepage hero");
    expect(hit).not.toBeNull();
  });

  it("returns null when candidate is shorter than 8 chars", () => {
    const s = sid("short-c");
    pushPendingNotification(s, mkNote({ task: "build the homepage" }));
    expect(findRecentCompletionMatching(s, "build")).toBeNull();
  });

  it("returns null when prior task normalizes to under 8 chars", () => {
    const s = sid("short-p");
    pushPendingNotification(s, mkNote({ task: "go" }));
    expect(findRecentCompletionMatching(s, "build the homepage")).toBeNull();
  });

  it("ignores entries older than the 10-min recency window", () => {
    const s = sid("old");
    const stale = mkNote({ task: "build the homepage hero", completedAt: Date.now() - 11 * 60 * 1000 });
    pushPendingNotification(s, stale);
    expect(findRecentCompletionMatching(s, "build the homepage hero")).toBeNull();
  });

  it("returns null when prior and candidate share no substring relationship", () => {
    const s = sid("nooverlap");
    pushPendingNotification(s, mkNote({ task: "rewrite the kraken trading bot" }));
    expect(findRecentCompletionMatching(s, "deploy the marketing site")).toBeNull();
  });

  it("history survives a drain (re-delegation guard)", () => {
    const s = sid("survive");
    pushPendingNotification(s, mkNote({ task: "build the homepage hero" }));
    drainPendingNotifications(s);
    const hit = findRecentCompletionMatching(s, "build the homepage hero");
    expect(hit).not.toBeNull();
  });
});

describe("findAnyRecentCompletion", () => {
  it("returns null when sessionId is empty", () => {
    expect(findAnyRecentCompletion("")).toBeNull();
  });

  it("returns null when no history exists", () => {
    expect(findAnyRecentCompletion(sid("none"))).toBeNull();
  });

  it("returns the most recent entry within the window", () => {
    const s = sid("recent");
    pushPendingNotification(s, mkNote({ opId: "older", completedAt: Date.now() - 5 * 60 * 1000 }));
    pushPendingNotification(s, mkNote({ opId: "newer" }));
    const hit = findAnyRecentCompletion(s);
    expect(hit?.opId).toBe("newer");
  });

  it("returns null when only stale entries exist (outside 10-min window)", () => {
    const s = sid("stale-only");
    pushPendingNotification(s, mkNote({ completedAt: Date.now() - 12 * 60 * 1000 }));
    expect(findAnyRecentCompletion(s)).toBeNull();
  });
});

describe("formatNotificationsForSystemPrompt", () => {
  it("returns empty string for empty input", () => {
    expect(formatNotificationsForSystemPrompt([])).toBe("");
  });

  it("uses ✓ for completed, ✗ for failed, ⊘ for cancelled", () => {
    const out = formatNotificationsForSystemPrompt([
      mkNote({ opId: "done", status: "completed" }),
      mkNote({ opId: "broke", status: "failed" }),
      mkNote({ opId: "cancel", status: "cancelled" }),
    ]);
    expect(out).toContain("✓ Background op `done` completed");
    expect(out).toContain("✗ Background op `broke` failed");
    expect(out).toContain("⊘ Background op `cancel` cancelled");
  });

  it("renders singular 'file' when filesChanged has exactly one entry", () => {
    const out = formatNotificationsForSystemPrompt([
      mkNote({ filesChanged: ["a.ts"] }),
    ]);
    expect(out).toContain("changed 1 file: a.ts");
    expect(out).not.toContain("1 files");
  });

  it("renders plural 'files' when filesChanged has more than one entry", () => {
    const out = formatNotificationsForSystemPrompt([
      mkNote({ filesChanged: ["a.ts", "b.ts", "c.ts"] }),
    ]);
    expect(out).toContain("changed 3 files: a.ts, b.ts, c.ts");
  });

  it("truncates filesChanged list to first 5 entries", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
    const out = formatNotificationsForSystemPrompt([mkNote({ filesChanged: files })]);
    expect(out).toContain("changed 7 files");
    expect(out).toContain("a.ts, b.ts, c.ts, d.ts, e.ts");
    expect(out).not.toContain("f.ts");
  });

  it("omits files line when filesChanged is empty", () => {
    const out = formatNotificationsForSystemPrompt([mkNote({ filesChanged: [] })]);
    expect(out).not.toMatch(/\(changed \d+ file/);
  });

  it("notes truncation when summary exceeds preview char budget", () => {
    const long = "x".repeat(500);
    const out = formatNotificationsForSystemPrompt([mkNote({ summary: long, opId: "long-op" })]);
    expect(out).toContain("…[full summary withheld — 500 chars total");
    expect(out).toContain('op_status(op_id="long-op")');
  });

  it("does not add truncation note when summary is short", () => {
    const out = formatNotificationsForSystemPrompt([mkNote({ summary: "short" })]);
    expect(out).not.toContain("full summary withheld");
  });

  it("truncates the original task to 160 chars with ellipsis", () => {
    const longTask = "fix " + "x".repeat(200);
    const out = formatNotificationsForSystemPrompt([mkNote({ task: longTask })]);
    expect(out).toContain("...");
    expect(out).not.toContain(longTask);
  });

  it("uses singular 'op' header when exactly one notification", () => {
    const out = formatNotificationsForSystemPrompt([mkNote()]);
    expect(out).toContain("1 op finished");
    expect(out).not.toContain("1 ops finished");
  });

  it("uses plural 'ops' header when more than one notification", () => {
    const out = formatNotificationsForSystemPrompt([mkNote(), mkNote(), mkNote()]);
    expect(out).toContain("3 ops finished");
  });

  it("includes the [end background completions] marker", () => {
    const out = formatNotificationsForSystemPrompt([mkNote()]);
    expect(out).toContain("[end background completions]");
  });
});
