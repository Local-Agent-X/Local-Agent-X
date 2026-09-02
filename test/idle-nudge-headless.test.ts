/**
 * Background jobs never interrupt chat (Peter-approved invariant).
 *
 * A failed dream/memory-consolidation op used to schedule the generic idle
 * nudge for its own `dream-<ts>` session. bg_op_nudge is a GLOBAL chat-WS
 * event (process-relay-delivery.ts GLOBAL_EVENT_TYPES), so the "hit a snag"
 * text fanned out to every connected client — a background job posting into
 * the user's chat. scheduleIdleNudge now suppresses headless sessions at the
 * source using the ONE headless predicate, chat-ws/state.ts
 * isHeadlessSession (prefixes eval_/skill-review-/dream-) — the same
 * discriminator broadcastToSession already applies. Failures stay visible in
 * logs and on the AGENTS panel dock (session-bridge-observer, untouched).
 *
 * Fixtures mirror the real minters: dream-check.ts `dream-${Date.now()}`,
 * skill-review.ts `skill-review-<ts>-<seq>`, routes/chat.ts randomId("eval").
 * `ide-` sessions are LIVE user chats (memory's SYNTHETIC_SESSION_PREFIXES
 * holds them too — that list must NOT become the discriminator here), so they
 * keep nudging.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelIdleNudge,
  scheduleIdleNudge,
  setIdleNudgeBroadcaster,
} from "../src/ops/idle-nudge.js";
import { drainPendingNotifications, pushPendingNotification } from "../src/ops/pending-notifications.js";
import { isHeadlessSession } from "../src/chat-ws/state.js";
import { randomId } from "../src/util/ids.js";

let counter = 0;
const suffix = (): string => `${Date.now()}-${counter++}`;

/** Push a failed completion (the "hit a snag" case) for the session. */
function pushFailed(sessionId: string): void {
  pushPendingNotification(sessionId, {
    opId: `op-headless-${counter}`,
    task: "consolidate recent session memories in the background overnight",
    status: "failed",
    completedAt: Date.now(),
  });
}

describe("scheduleIdleNudge — headless/background sessions never nudge chat", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    setIdleNudgeBroadcaster(null as unknown as Parameters<typeof setIdleNudgeBroadcaster>[0]);
  });

  it("a failed dream/memory-consolidation op produces NO chat nudge", () => {
    const s = `dream-${suffix()}`;
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushFailed(s);
    scheduleIdleNudge(s, "consolidate memories");
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fired).toBe(false);
    drainPendingNotifications(s);
  });

  it("a dream batch session (dream-<ts>-bN) is suppressed too", () => {
    const s = `dream-${suffix()}-b2`;
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushFailed(s);
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fired).toBe(false);
    drainPendingNotifications(s);
  });

  it("an explicit-notify task hint does not bypass the headless suppression", () => {
    const s = `dream-${suffix()}`;
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushFailed(s);
    // The 1s fast path must not resurrect the nudge for a background session.
    scheduleIdleNudge(s, "tell me when the consolidation is done");
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fired).toBe(false);
    drainPendingNotifications(s);
  });

  it("a skill-review session produces NO chat nudge", () => {
    const s = `skill-review-${suffix()}`;
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushFailed(s);
    scheduleIdleNudge(s, "review the last turn for promotable skills");
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fired).toBe(false);
    drainPendingNotifications(s);
  });

  it("an eval session (as minted by routes/chat.ts randomId('eval')) produces NO chat nudge", () => {
    const s = randomId("eval");
    expect(isHeadlessSession(s)).toBe(true); // fixture derived from the real minter
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushFailed(s);
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(fired).toBe(false);
    drainPendingNotifications(s);
  });

  it("a failed op on a REAL user chat session still nudges exactly as before", () => {
    const s = `chat-${suffix()}`;
    let captured: { sessionId?: string; event?: { type: string; opIds: string[]; text: string } } = {};
    setIdleNudgeBroadcaster((sessionId, event) => {
      captured = { sessionId, event: event as { type: string; opIds: string[]; text: string } };
    });
    pushPendingNotification(s, {
      opId: "op-real-failed",
      task: "refactor the dispatch loop in the background while the user is away",
      status: "failed",
      completedAt: Date.now(),
    });
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(captured.sessionId).toBe(s);
    expect(captured.event?.type).toBe("bg_op_nudge");
    expect(captured.event?.opIds).toEqual(["op-real-failed"]);
    expect(captured.event?.text.toLowerCase()).toContain("snag");
    drainPendingNotifications(s);
  });

  it("an ide- session is a LIVE user chat and still nudges (do not widen to SYNTHETIC_SESSION_PREFIXES)", () => {
    const s = `ide-${suffix()}`;
    expect(isHeadlessSession(s)).toBe(false);
    let fired = false;
    setIdleNudgeBroadcaster(() => { fired = true; });
    pushFailed(s);
    scheduleIdleNudge(s);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(fired).toBe(true);
    drainPendingNotifications(s);
  });

  it("suppression leaves no dangling timer — a later cancel is a safe no-op", () => {
    const s = `dream-${suffix()}`;
    setIdleNudgeBroadcaster(() => { throw new Error("must never fire for headless"); });
    pushFailed(s);
    scheduleIdleNudge(s);
    expect(() => cancelIdleNudge(s)).not.toThrow();
    vi.advanceTimersByTime(10 * 60 * 1000);
    drainPendingNotifications(s);
  });
});
