import { describe, it, expect, afterEach, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { getLaxDir } from "../lax-data-dir.js";
import { writeOp } from "../ops/op-store.js";
import { appendOpMessage } from "./store.js";
import { trackOpForSession, listOpsForSession, setSessionBroadcaster } from "../ops/session-bridge.js";
import { collectCanonicalBrowserEvents, recordCanonicalEvent } from "./session-bridge-observer.js";
import { getBus, streamChannel } from "./bus.js";
import type { CanonicalEvent } from "./types.js";

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
