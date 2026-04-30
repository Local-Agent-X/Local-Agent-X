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

describe("history vs queue: distinct caps and TTLs", () => {
  it("history cap (30) is independent of queue cap (20) — findAnyRecentCompletion still works after drain when 25+ items pushed", () => {
    const s = sid("hist-cap");
    for (let i = 0; i < 25; i++) {
      pushPendingNotification(s, mkNote({ opId: `op-${i}` }));
    }
    drainPendingNotifications(s); // queue cleared, history retained
    const hit = findAnyRecentCompletion(s);
    // History cap is 30 so all 25 should still be retrievable; the most
    // recent one (op-24) should be returned.
    expect(hit?.opId).toBe("op-24");
  });

  it("history cap (30) drops oldest first when exceeded — after 35 pushes, op-0..op-4 are gone but op-5..op-34 remain", () => {
    const s = sid("hist-overflow");
    // Use spaced-out tasks so findRecentCompletionMatching can target a specific entry
    for (let i = 0; i < 35; i++) {
      pushPendingNotification(s, mkNote({ opId: `op-${i}`, task: `unique-task-marker-${i}-padding-text` }));
    }
    // op-0..op-4 should be gone from history (35 - 30 = 5 dropped)
    expect(findRecentCompletionMatching(s, "unique-task-marker-2-padding-text")).toBeNull();
    // op-5 should be the oldest still in history
    expect(findRecentCompletionMatching(s, "unique-task-marker-5-padding-text")).not.toBeNull();
    // op-34 should be the newest
    expect(findRecentCompletionMatching(s, "unique-task-marker-34-padding-text")).not.toBeNull();
  });

  it("history TTL (30 min) is shorter than queue TTL (24 h)", () => {
    const s = sid("hist-ttl");
    // Push something 31 min old — beyond HISTORY_TTL_MS but well within TTL_MS
    const stale = mkNote({ opId: "stale", task: "old task with enough text to match", completedAt: Date.now() - 31 * 60 * 1000 });
    pushPendingNotification(s, stale);
    // History prune fires inside push, so the 31-min-old entry is dropped from history.
    // findRecentCompletionMatching reads from history and uses the 10-min recency
    // window, so it would have rejected it anyway — but findAnyRecentCompletion
    // also reads from history.
    expect(findAnyRecentCompletion(s)).toBeNull();
    // Push a fresh item to trigger another prune; history should now contain only the fresh one
    pushPendingNotification(s, mkNote({ opId: "fresh", task: "new task with enough text" }));
    expect(findAnyRecentCompletion(s)?.opId).toBe("fresh");
  });

  it("a stale push triggers prune that removes the empty session entry from history", () => {
    const s = sid("empty-prune");
    // Push only stale items (older than HISTORY_TTL_MS)
    pushPendingNotification(s, mkNote({ completedAt: Date.now() - 31 * 60 * 1000 }));
    // Push a second stale item; the prune-on-push from THIS call sees only stale items
    pushPendingNotification(s, mkNote({ completedAt: Date.now() - 31 * 60 * 1000 }));
    // Both findAnyRecentCompletion and findRecentCompletionMatching should miss
    expect(findAnyRecentCompletion(s)).toBeNull();
    expect(findRecentCompletionMatching(s, "anything matching as a long candidate")).toBeNull();
  });
});

describe("findAnyRecentCompletion — backward scan invariants", () => {
  it("scans backward through history and returns the FIRST recent hit (most recent in push order)", () => {
    const s = sid("backscan");
    pushPendingNotification(s, mkNote({ opId: "a", completedAt: Date.now() - 9 * 60 * 1000 })); // recent
    pushPendingNotification(s, mkNote({ opId: "b", completedAt: Date.now() - 8 * 60 * 1000 })); // recent, more recent
    pushPendingNotification(s, mkNote({ opId: "c", completedAt: Date.now() - 7 * 60 * 1000 })); // recent, most recent
    expect(findAnyRecentCompletion(s)?.opId).toBe("c");
  });

  it("skips a stale tail entry and returns the most-recent fresh one earlier in the array", () => {
    const s = sid("skip-tail");
    pushPendingNotification(s, mkNote({ opId: "fresh", completedAt: Date.now() - 5 * 60 * 1000 }));
    pushPendingNotification(s, mkNote({ opId: "stale", completedAt: Date.now() - 11 * 60 * 1000 }));
    // Note: stale.completedAt is past the 10-min recency window even though it
    // was pushed AFTER fresh — because completedAt drives the window check, not
    // push order. The function returns null only if NO entry is recent.
    // Actually, "stale" here was pushed second so it's at index [1]. The scan
    // starts from i=length-1 (i.e. stale) and skips, then hits fresh at i=0.
    expect(findAnyRecentCompletion(s)?.opId).toBe("fresh");
  });
});

describe("findRecentCompletionMatching — boundary cases", () => {
  it("uses the 120-char prefix when comparing (long prior task)", () => {
    const s = sid("prefix");
    const longPrior = "a".repeat(200) + " unique-tail-content";
    pushPendingNotification(s, mkNote({ task: longPrior }));
    // The candidate matches the FIRST 120 chars of the prior — the unique tail
    // is sliced off so it should NOT influence the comparison.
    const candidate = "a".repeat(50);
    const hit = findRecentCompletionMatching(s, candidate);
    expect(hit).not.toBeNull();
  });

  it("ignores stale entries even when an older recent one matches", () => {
    const s = sid("stale-match");
    // Stale entry (12 min old, beyond 10-min window) that DOES match the candidate
    pushPendingNotification(s, mkNote({
      task: "build the homepage hero section",
      completedAt: Date.now() - 12 * 60 * 1000,
    }));
    // No other entries
    expect(findRecentCompletionMatching(s, "build the homepage hero section")).toBeNull();
  });

  it("returns the FIRST match in chronological push order (not the most recent)", () => {
    const s = sid("first-match");
    pushPendingNotification(s, mkNote({ opId: "first", task: "build the dashboard widget" }));
    pushPendingNotification(s, mkNote({ opId: "second", task: "build the dashboard widget for admin" }));
    // Both match "build the dashboard widget" but the for-of loop returns the first hit.
    const hit = findRecentCompletionMatching(s, "build the dashboard widget");
    expect(hit?.opId).toBe("first");
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

  it("does NOT add truncation note when summary is exactly the 180-char preview length", () => {
    // SUMMARY_PREVIEW_CHARS is 180. A summary EXACTLY 180 chars long has
    // n.summary.length === SUMMARY_PREVIEW_CHARS, so the > check is false
    // and the truncation note is omitted.
    const exactly180 = "a".repeat(180);
    const out = formatNotificationsForSystemPrompt([mkNote({ summary: exactly180 })]);
    expect(out).not.toContain("full summary withheld");
    expect(out).toContain(exactly180);
  });

  it("DOES add truncation note when summary is one char over the preview length", () => {
    const oneOver = "a".repeat(181);
    const out = formatNotificationsForSystemPrompt([mkNote({ summary: oneOver, opId: "boundary-op" })]);
    expect(out).toContain("full summary withheld — 181 chars total");
    expect(out).toContain('op_status(op_id="boundary-op")');
  });

  it("renders preview at exactly 180 chars (no extra slicing artifact)", () => {
    const oneOver = "x".repeat(181);
    const out = formatNotificationsForSystemPrompt([mkNote({ summary: oneOver })]);
    // Preview is summary.slice(0, 180) — should have exactly 180 'x's followed by the truncation note
    const previewRegion = out.match(/Preview: (x+)/);
    expect(previewRegion).not.toBeNull();
    expect(previewRegion![1].length).toBe(180);
  });

  it("appends task ellipsis when task length is 161 chars (boundary +1 over 160-char clip)", () => {
    const longTask = "x".repeat(161);
    const out = formatNotificationsForSystemPrompt([mkNote({ task: longTask })]);
    expect(out).toContain("...");
    // Task is sliced to 160 chars, so the rendered region should have 160 x's.
    const m = out.match(/Original task: "(x+)\.{3}"/);
    expect(m).not.toBeNull();
    expect(m![1].length).toBe(160);
  });

  it("does NOT append task ellipsis when task length is exactly 160 chars", () => {
    const exact = "x".repeat(160);
    const out = formatNotificationsForSystemPrompt([mkNote({ task: exact })]);
    expect(out).toContain(`Original task: "${exact}"`);
    // No trailing ellipsis on the original task line
    expect(out).not.toMatch(/Original task: "x{160}\.{3}/);
  });

  it("renders exactly 5 files in the preview when filesChanged has more than 5", () => {
    const files = Array.from({ length: 12 }, (_, i) => `file${i}.ts`);
    const out = formatNotificationsForSystemPrompt([mkNote({ filesChanged: files })]);
    expect(out).toContain("changed 12 files: file0.ts, file1.ts, file2.ts, file3.ts, file4.ts");
    expect(out).not.toContain("file5.ts");
  });
});
