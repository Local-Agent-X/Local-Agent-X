import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelIdleNudge,
  isLastMessageCasual,
  markSessionExplicitNotify,
  recordSessionLastMessage,
  scheduleIdleNudge,
  setIdleNudgeBroadcaster,
  setIdleNudgePersister,
} from "../src/workers/idle-nudge.js";
import { drainPendingNotifications, pushPendingNotification } from "../src/workers/pending-notifications.js";

let counter = 0;
const sid = (tag: string): string => `nudge-test-${tag}-${Date.now()}-${counter++}`;

afterEach(() => {
  setIdleNudgeBroadcaster(null as unknown as Parameters<typeof setIdleNudgeBroadcaster>[0]);
  setIdleNudgePersister(null as unknown as Parameters<typeof setIdleNudgePersister>[0]);
});

describe("recordSessionLastMessage + isLastMessageCasual", () => {
  it("returns false when no message has been recorded", () => {
    expect(isLastMessageCasual(sid("none"))).toBe(false);
  });

  it("returns true for short messages (<= 30 chars)", () => {
    const s = sid("short");
    recordSessionLastMessage(s, "hey there");
    expect(isLastMessageCasual(s)).toBe(true);
  });

  it("returns true for casual greetings even when longer than 30 chars", () => {
    const s = sid("casual");
    recordSessionLastMessage(s, "yo what's up dude how are things going today");
    expect(isLastMessageCasual(s)).toBe(true);
  });

  it("returns false for a long substantive message", () => {
    const s = sid("substantive");
    recordSessionLastMessage(s, "Please refactor the worker pool dispatch loop to use a priority queue with proper FIFO within lanes");
    expect(isLastMessageCasual(s)).toBe(false);
  });

  it("matches casual prefixes case-insensitively (THANKS, OK, etc.)", () => {
    const s = sid("ci");
    recordSessionLastMessage(s, "THANKS for the help with that long task earlier");
    expect(isLastMessageCasual(s)).toBe(true);
  });

  it("treats 'got it' as casual", () => {
    const s = sid("got-it");
    recordSessionLastMessage(s, "got it, that makes sense and I will try it now");
    expect(isLastMessageCasual(s)).toBe(true);
  });

  it("ignores empty session id and empty message inputs", () => {
    recordSessionLastMessage("", "anything");
    recordSessionLastMessage(sid("emptymsg"), "");
    expect(isLastMessageCasual("")).toBe(false);
  });
});

describe("markSessionExplicitNotify — pattern detection", () => {
  it("matches 'tell me when'", () => {
    const s = sid("tell-when");
    markSessionExplicitNotify(s, "Refactor the dispatch loop and tell me when it's done please");
    expect(scheduledImmediate(s, "task")).toBe(true);
  });

  it("matches 'update me once'", () => {
    const s = sid("update-once");
    markSessionExplicitNotify(s, "Build the new endpoint and update me once it ships to prod");
    expect(scheduledImmediate(s, "task")).toBe(true);
  });

  it("matches 'notify me when'", () => {
    const s = sid("notify-when");
    markSessionExplicitNotify(s, "Update the README and notify me when the PR is up");
    expect(scheduledImmediate(s, "task")).toBe(true);
  });

  it("matches 'ping me when'", () => {
    const s = sid("ping-when");
    markSessionExplicitNotify(s, "Migrate the schema and ping me when it's safe to roll out");
    expect(scheduledImmediate(s, "task")).toBe(true);
  });

  it("matches 'message me as soon as'", () => {
    const s = sid("msg-soon");
    markSessionExplicitNotify(s, "Run the audit and message me as soon as it finishes");
    expect(scheduledImmediate(s, "task")).toBe(true);
  });

  it("does NOT match a non-notify message", () => {
    const s = sid("no-match");
    markSessionExplicitNotify(s, "Refactor the dispatch loop carefully and check the tests");
    expect(scheduledImmediate(s, "task")).toBe(false);
  });

  // Documented gap (see BUGS-FOUND.md item #2): the regex requires the
  // notify-verb to be IMMEDIATELY followed by me/us then when/once/after/etc,
  // so the very common English phrasing "let me know when X" does NOT match.
  // Captured here as a regression guard until the regex is widened.
  it("does NOT match 'let me know when' (regex gap)", () => {
    const s = sid("let-know-when");
    markSessionExplicitNotify(s, "Build the new endpoint and let me know when it ships to prod");
    expect(scheduledImmediate(s, "task")).toBe(false);
  });

  it("does NOT match 'let me know once' (regex gap)", () => {
    const s = sid("let-know-once");
    markSessionExplicitNotify(s, "Run the audit and let me know once it has finished running");
    expect(scheduledImmediate(s, "task")).toBe(false);
  });

  it("ignores empty session and message", () => {
    markSessionExplicitNotify("", "tell me when done");
    markSessionExplicitNotify(sid("empty"), "");
    // No-op: nothing to assert except no throw
    expect(true).toBe(true);
  });

  // Helper to peek scheduled-delay behavior without exposing internals:
  // schedule a nudge with a non-matching task hint and see if the delay is
  // explicit (1s) or idle (2min). We can't read the timer directly, so we
  // use fake timers and advance by 1.5s to see if it fires.
  function scheduledImmediate(sessionId: string, taskHint: string): boolean {
    vi.useFakeTimers();
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushPendingNotification(sessionId, {
      opId: "op-test",
      task: "an op finished its work just now in the background",
      status: "completed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(sessionId, taskHint);
    vi.advanceTimersByTime(1500);
    cancelIdleNudge(sessionId);
    drainPendingNotifications(sessionId);
    vi.useRealTimers();
    return fired;
  }
});

describe("scheduleIdleNudge + cancelIdleNudge — timer mechanics", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fires after 2 min for the default idle delay", () => {
    const s = sid("default-delay");
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushPendingNotification(s, {
      opId: "op-1",
      task: "completed something interesting in the background just now",
      status: "completed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(60_000);
    expect(fired).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(fired).toBe(true);
  });

  it("cancelIdleNudge stops the timer", () => {
    const s = sid("cancel");
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushPendingNotification(s, {
      opId: "op-2",
      task: "an op completed in the background just now to test cancel",
      status: "completed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(60_000);
    cancelIdleNudge(s);
    vi.advanceTimersByTime(120_000);
    expect(fired).toBe(false);
    drainPendingNotifications(s);
  });

  it("calling schedule twice replaces the prior timer (no double fire)", () => {
    const s = sid("replace");
    let count = 0;
    setIdleNudgeBroadcaster(() => { count++; });
    pushPendingNotification(s, {
      opId: "op-3",
      task: "an op completed just now and we are testing replacement of the timer",
      status: "completed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(60_000);
    scheduleIdleNudge(s); // reset timer
    vi.advanceTimersByTime(60_000); // would have fired without reset
    expect(count).toBe(0);
    vi.advanceTimersByTime(60_000); // fires now
    expect(count).toBe(1);
  });

  it("does not fire if the queue is empty when the timer fires", () => {
    const s = sid("empty-queue");
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(120_000);
    expect(fired).toBe(false);
  });

  it("explicit-notify task hint fires within 1s", () => {
    const s = sid("explicit-task");
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushPendingNotification(s, {
      opId: "op-4",
      task: "a long task finished just now while we are testing fast nudge",
      status: "completed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s, "Tell me when the migration finishes please");
    vi.advanceTimersByTime(500);
    expect(fired).toBe(false);
    vi.advanceTimersByTime(600);
    expect(fired).toBe(true);
  });

  it("explicit-notify user msg flag fires within 1s even with non-matching task hint", () => {
    const s = sid("explicit-user");
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushPendingNotification(s, {
      opId: "op-5",
      task: "a regular long task in the background that just completed for the test",
      status: "completed",
      completedAt: Date.now(),
    });
    markSessionExplicitNotify(s, "Refactor the auth module and ping me when it is done");
    scheduleIdleNudge(s, "task description without the trigger phrase here");
    vi.advanceTimersByTime(1100);
    expect(fired).toBe(true);
  });

  it("ignores empty sessionId silently", () => {
    expect(() => scheduleIdleNudge("")).not.toThrow();
  });
});

describe("scheduleIdleNudge — broadcaster + persister payload", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("broadcasts a bg_op_nudge event with opIds when fired", () => {
    const s = sid("payload");
    let captured: { sessionId?: string; event?: { type: string; opIds: string[]; text: string } } = {};
    setIdleNudgeBroadcaster((sessionId, event) => {
      captured = { sessionId, event: event as { type: string; opIds: string[]; text: string } };
    });
    pushPendingNotification(s, {
      opId: "op-payload-1",
      task: "the first long op completed in the background just now for the test",
      status: "completed",
      completedAt: Date.now(),
    });
    pushPendingNotification(s, {
      opId: "op-payload-2",
      task: "the second long op also completed in the background recently for the test",
      status: "failed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(120_000);
    expect(captured.sessionId).toBe(s);
    expect(captured.event?.type).toBe("bg_op_nudge");
    expect(captured.event?.opIds).toEqual(["op-payload-1", "op-payload-2"]);
    expect(typeof captured.event?.text).toBe("string");
    expect(captured.event?.text.length).toBeGreaterThan(0);
  });

  it("invokes persister alongside broadcaster on fire", () => {
    const s = sid("persist");
    setIdleNudgeBroadcaster(() => {});
    let persisted = "";
    setIdleNudgePersister((_sessionId, content) => { persisted = content; });
    pushPendingNotification(s, {
      opId: "op-persist",
      task: "this op finished while user was away and we want it persisted",
      status: "completed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(120_000);
    expect(persisted.length).toBeGreaterThan(0);
  });

  it("drains the queue after firing (subsequent drain returns empty)", () => {
    const s = sid("drain-on-fire");
    setIdleNudgeBroadcaster(() => {});
    pushPendingNotification(s, {
      opId: "op-drain",
      task: "an op completed in the background and the nudge should drain it on fire",
      status: "completed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(120_000);
    expect(drainPendingNotifications(s)).toEqual([]);
  });

  it("text mentions 'finished' for completed status (single op)", () => {
    const s = sid("text-completed");
    let text = "";
    setIdleNudgeBroadcaster((_sessionId, event) => {
      text = (event as { text: string }).text;
    });
    pushPendingNotification(s, {
      opId: "op-text",
      task: "a long task completed in the background and we are testing text shape",
      status: "completed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(120_000);
    expect(text.toLowerCase()).toContain("finished");
  });

  it("text mentions 'snag' for failed status (single op)", () => {
    const s = sid("text-failed");
    let text = "";
    setIdleNudgeBroadcaster((_sessionId, event) => {
      text = (event as { text: string }).text;
    });
    pushPendingNotification(s, {
      opId: "op-fail",
      task: "a long task failed in the background and we want to surface it gracefully",
      status: "failed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(120_000);
    expect(text.toLowerCase()).toContain("snag");
  });

  it("text uses summary form for multiple ops (counts completed/failed)", () => {
    const s = sid("text-multi");
    let text = "";
    setIdleNudgeBroadcaster((_sessionId, event) => {
      text = (event as { text: string }).text;
    });
    pushPendingNotification(s, {
      opId: "op-m1",
      task: "first multi op completed in the background just now for the test",
      status: "completed",
      completedAt: Date.now(),
    });
    pushPendingNotification(s, {
      opId: "op-m2",
      task: "second multi op completed in the background just now for the test",
      status: "completed",
      completedAt: Date.now(),
    });
    pushPendingNotification(s, {
      opId: "op-m3",
      task: "third multi op failed in the background just now for the test",
      status: "failed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(120_000);
    expect(text).toContain("2 finished");
    expect(text).toContain("1 failed");
  });
});
