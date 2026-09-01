import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { writeOp } from "../ops/op-store.js";
import { appendOpMessage } from "./store.js";
import { trackOpForSession, listOpsForSession, setSessionBroadcaster } from "../ops/session-bridge.js";
import { pushPendingNotification } from "../ops/pending-notifications.js";
import { cancelIdleNudge, scheduleIdleNudge } from "../ops/idle-nudge.js";
import { collectCanonicalBrowserEvents, recordCanonicalEvent } from "./session-bridge-observer.js";
import { getBus, streamChannel } from "./bus.js";
import type { CanonicalEvent } from "./types.js";

// Spy-wrap the two side-channel sinks the observer feeds on terminal state so
// the headless-job cases below can prove "no notification, no nudge". The real
// implementations still run underneath, so the ordinary-op cases are unchanged.
vi.mock("../ops/idle-nudge.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ops/idle-nudge.js")>();
  return { ...real, scheduleIdleNudge: vi.fn(real.scheduleIdleNudge) };
});
vi.mock("../ops/pending-notifications.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../ops/pending-notifications.js")>();
  return { ...real, pushPendingNotification: vi.fn(real.pushPendingNotification) };
});

// Regression: chat_turn (and other sidebar-suppressed) ops were tracked in the
// session→op map but never released on terminal state, because the observer
// early-returned for those types BEFORE reaching releaseOpFromSession. The leak
// made listOpsForSession grow unbounded, which fired the Anthropic-hardcoded
// worker-redirect Haiku classifier on every later turn (even on Codex/Grok) and
// injected phantom "[PARALLEL CONTEXT]" workers into the system prompt.

const created: string[] = [];

function makeOp(id: string, type: string): void {
  writeOp({ id, type, status: "running" } as never);
  created.push(id);
}

function stateChanged(opId: string, to: string): CanonicalEvent {
  return { type: "state_changed", opId, body: { from: "running", to } } as unknown as CanonicalEvent;
}

afterEach(() => {
  for (const id of created) {
    try { rmSync(join(getLaxDir(), "operations", id), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  created.length = 0;
});

describe("session-bridge-observer — terminal release for suppressed op types", () => {
  it("releases a chat_turn op from the session map when it succeeds", () => {
    const sessionId = "sess-obs-chat";
    const opId = "op_chat_turn_test_release_1";
    makeOp(opId, "chat_turn");
    trackOpForSession(opId, sessionId, "prior user message");

    expect(listOpsForSession(sessionId)).toContain(opId);

    recordCanonicalEvent(stateChanged(opId, "succeeded"));

    // The leak: this used to still contain opId forever.
    expect(listOpsForSession(sessionId)).toEqual([]);
  });

  it("keeps a chat_turn op while it is still running", () => {
    const sessionId = "sess-obs-running";
    const opId = "op_chat_turn_test_running_1";
    makeOp(opId, "chat_turn");
    trackOpForSession(opId, sessionId, "prior user message");

    recordCanonicalEvent(stateChanged(opId, "running"));

    expect(listOpsForSession(sessionId)).toContain(opId);
  });

  it("releases on failed and cancelled too", () => {
    const sessionId = "sess-obs-fail";
    const failId = "op_chat_turn_test_fail_1";
    const cancelId = "op_voice_turn_test_cancel_1";
    makeOp(failId, "chat_turn");
    makeOp(cancelId, "voice_turn");
    trackOpForSession(failId, sessionId, "x");
    trackOpForSession(cancelId, sessionId, "y");

    recordCanonicalEvent(stateChanged(failId, "failed"));
    recordCanonicalEvent(stateChanged(cancelId, "cancelled"));

    expect(listOpsForSession(sessionId)).toEqual([]);
  });

  it.each(["failed", "cancelled"] as const)("preserves %s status instead of replaying stale success text", (status) => {
    const sessionId = `sess-obs-${status}`;
    const opId = `op_replay_${status}_1`;
    makeOp(opId, "research");
    appendOpMessage({
      opId, messageId: `message-${status}`, turnIdx: 0, seqInTurn: 0,
      role: "assistant", content: { text: "Done." }, createdAt: new Date().toISOString(),
    });
    trackOpForSession(opId, sessionId, "phone task");
    const broadcast = vi.fn();
    setSessionBroadcaster(broadcast);

    recordCanonicalEvent(stateChanged(opId, status));

    expect(broadcast).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      type: "bg_op_completed", status, summary: status,
    }));
    expect(broadcast).not.toHaveBeenCalledWith(sessionId, expect.objectContaining({ summary: "Done." }));
  });

  it("collects browser events without consuming core terminal side effects", () => {
    const sessionId = "sess-obs-split";
    const opId = "op_observer_projection_split";
    makeOp(opId, "research");
    trackOpForSession(opId, sessionId, "split projection");
    const event = stateChanged(opId, "succeeded");

    const projection = collectCanonicalBrowserEvents(event, sessionId);
    expect(projection?.events.map(candidate => candidate.type))
      .toEqual(["bg_op_completed", "worker_done"]);
    expect(listOpsForSession(sessionId)).toContain(opId);

    recordCanonicalEvent(event, "non-browser", sessionId);
    expect(listOpsForSession(sessionId)).toEqual([]);
  });

  it.each(["chat_turn", "agent_spawn", "voice_turn"])(
    "does not install sidebar stream forwarding for suppressed %s ops",
    (type) => {
      const sessionId = `sess-obs-suppressed-${type}`;
      const opId = `op_suppressed_stream_${type}`;
      makeOp(opId, type);
      trackOpForSession(opId, sessionId, "suppressed stream");
      const broadcast = vi.fn();
      setSessionBroadcaster(broadcast);

      recordCanonicalEvent({
        type: "state_changed", opId, body: { from: null, to: "queued" },
      } as unknown as CanonicalEvent, "non-browser", sessionId);
      getBus().publish(streamChannel(opId), { delta: "private lane output" });

      expect(broadcast).not.toHaveBeenCalled();
    },
  );
});

// Regression: skill-review runs through runAgentViaCanonical on the background
// lane, bound by trackOpForSession to its synthetic fork session
// (skill-review-<ts>-<seq>). bg_op_* is a GLOBAL chat-WS event family, so an
// unsuppressed lifecycle put a "Worker: <reviewed-turn …> FAILED" card in every
// client's AGENTS panel and, two minutes later, an idle nudge ("hit a snag").
const TERMINAL_STATES = ["succeeded", "failed", "cancelled"] as const;

function queued(opId: string): CanonicalEvent {
  return { type: "state_changed", opId, body: { from: null, to: "queued" } } as unknown as CanonicalEvent;
}

describe("session-bridge-observer — skill_review never reaches the sidebar", () => {
  beforeEach(() => {
    vi.mocked(scheduleIdleNudge).mockClear();
    vi.mocked(pushPendingNotification).mockClear();
  });

  it.each(TERMINAL_STATES)("skill_review → %s emits no bg_op events, no pending notification and no idle nudge", (to) => {
    const sessionId = `sess-obs-skill-review-${to}`;
    const opId = `op_skill_review_${to}`;
    makeOp(opId, "skill_review");
    trackOpForSession(opId, sessionId, "reviewed turn");
    const broadcast = vi.fn();
    setSessionBroadcaster(broadcast);

    recordCanonicalEvent(queued(opId));
    recordCanonicalEvent(stateChanged(opId, "running"));
    recordCanonicalEvent({ type: "turn_committed", opId, body: { turnIdx: 1, tools: [] } } as unknown as CanonicalEvent);
    recordCanonicalEvent({ type: "error", opId, body: { code: "boom", message: "x" } } as unknown as CanonicalEvent);
    getBus().publish(streamChannel(opId), { delta: "reviewer output" });
    recordCanonicalEvent(stateChanged(opId, to));

    expect(broadcast).not.toHaveBeenCalled();
    expect(pushPendingNotification).not.toHaveBeenCalled();
    expect(scheduleIdleNudge).not.toHaveBeenCalled();
  });

  it.each(TERMINAL_STATES)("skill_review → %s is still released from the session at terminal", (to) => {
    const sessionId = `sess-obs-skill-review-release-${to}`;
    const opId = `op_skill_review_release_${to}`;
    makeOp(opId, "skill_review");
    trackOpForSession(opId, sessionId, "reviewed turn");

    recordCanonicalEvent(stateChanged(opId, "running"));
    expect(listOpsForSession(sessionId)).toContain(opId);

    recordCanonicalEvent(stateChanged(opId, to));
    expect(listOpsForSession(sessionId)).toEqual([]);
  });

  // Pin, not a regression: memory_consolidation must KEEP emitting — its
  // bg_op_queued/started (with opType) are the only feed for the ambient
  // "dreaming" dock in public/js/chat-agent-feeds-ambient.js. Never suppress it.
  it("memory_consolidation (dream) still emits bg_op_queued/started with opType and bg_op_completed", () => {
    const sessionId = "sess-obs-dream-1";
    const opId = "op_dream_memory_consolidation_1";
    makeOp(opId, "memory_consolidation");
    trackOpForSession(opId, sessionId, "dream pass");
    const broadcast = vi.fn();
    setSessionBroadcaster(broadcast);

    recordCanonicalEvent(queued(opId));
    recordCanonicalEvent(stateChanged(opId, "running"));
    recordCanonicalEvent(stateChanged(opId, "succeeded"));

    expect(broadcast).toHaveBeenCalledWith(sessionId, expect.objectContaining({ type: "bg_op_queued", opType: "memory_consolidation" }));
    expect(broadcast).toHaveBeenCalledWith(sessionId, expect.objectContaining({ type: "bg_op_started", opType: "memory_consolidation" }));
    expect(broadcast).toHaveBeenCalledWith(sessionId, expect.objectContaining({ type: "bg_op_completed", status: "completed" }));
    expect(listOpsForSession(sessionId)).toEqual([]);
    cancelIdleNudge(sessionId);
  });

  it("an ordinary research op still emits, notifies and nudges", () => {
    const sessionId = "sess-obs-ordinary-research";
    const opId = "op_ordinary_research_1";
    makeOp(opId, "research");
    trackOpForSession(opId, sessionId, "look into it");
    const broadcast = vi.fn();
    setSessionBroadcaster(broadcast);

    recordCanonicalEvent(queued(opId));
    recordCanonicalEvent(stateChanged(opId, "succeeded"));

    expect(broadcast).toHaveBeenCalledWith(sessionId, expect.objectContaining({ type: "bg_op_queued", opType: "research" }));
    expect(broadcast).toHaveBeenCalledWith(sessionId, expect.objectContaining({ type: "bg_op_completed", status: "completed" }));
    expect(pushPendingNotification).toHaveBeenCalledWith(sessionId, expect.objectContaining({ opId, status: "completed" }));
    expect(scheduleIdleNudge).toHaveBeenCalledWith(sessionId, "look into it");
    expect(listOpsForSession(sessionId)).toEqual([]);
    cancelIdleNudge(sessionId);
  });
});
