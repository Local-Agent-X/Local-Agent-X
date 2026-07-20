import { describe, expect, it, vi } from "vitest";
import type { ControlTransport } from "../screen-stream/peer.js";
import {
  PhoneProjectionBridge,
  projectDurableOperation,
  snapshotCoveredVersions,
  type PhoneProjectionItem,
  type PhoneProjectionSource,
} from "./phone-projection.js";
import type { Op } from "../ops/types.js";

class FakeTransport implements ControlTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  private message: (text: string) => void = () => {};
  private closeHandler: () => void = () => {};
  send(text: string): void { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
  onMessage(handler: (text: string) => void): void { this.message = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  emit(frame: unknown): void { this.message(JSON.stringify(frame)); }
  close(): void { this.closeHandler(); }
}

function source(snapshot: PhoneProjectionItem[] = []) {
  const listeners = new Map<string, (item: PhoneProjectionItem) => void>();
  const subscribe = vi.fn((sessionId: string, listener: (item: PhoneProjectionItem) => void) => {
    listeners.set(sessionId, listener);
    return () => listeners.delete(sessionId);
  });
  return {
    value: { snapshot: vi.fn(() => snapshot), subscribe } satisfies PhoneProjectionSource,
    emit: (sessionId: string, item: PhoneProjectionItem) => listeners.get(sessionId)?.(item),
  };
}

const subscribe = (transport: FakeTransport, sessionId = "session-a", afterSeq?: number) => transport.emit({
  type: "phone_projection_subscribe", deviceId: "phone-1", sessionId,
  ...(afterSeq === undefined ? {} : { afterSeq }),
});

describe("read-only phone projection", () => {
  it("binds subscriptions to the paired phone and selected session", () => {
    const s = source();
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: s.value });
    const transport = new FakeTransport();
    bridge.attach(transport);
    transport.emit({ type: "phone_projection_subscribe", deviceId: "phone-2", sessionId: "session-a" });
    expect(transport.sent).toEqual([{ type: "phone_projection_error", version: 1, code: "unauthorized" }]);
    expect(s.value.subscribe).not.toHaveBeenCalled();

    subscribe(transport);
    s.emit("session-b", { kind: "output", text: "wrong", replace: false });
    s.emit("session-a", { kind: "output", text: "right", replace: false });
    expect(transport.sent.at(-1)).toMatchObject({ sessionId: "session-a", item: { text: "right" } });

    subscribe(transport, "session-b", 0);
    expect(transport.sent.at(-1)).toEqual({ type: "phone_projection_error", version: 1, code: "unauthorized" });
    s.emit("session-b", { kind: "output", text: "still wrong", replace: false });
    expect(transport.sent.at(-1)).toEqual({ type: "phone_projection_error", version: 1, code: "unauthorized" });
  });

  it.each([
    { type: "chat", sessionId: "session-a", message: "mutate" },
    { type: "stop", sessionId: "session-a" },
    { type: "approve", approvalId: "a1" },
    { type: "redirect", opId: "op-1", instruction: "change it" },
    { t: "req", method: "POST", path: "/api/sessions", body: "{}" },
    { type: "phone_projection_subscribe", deviceId: "phone-1", sessionId: "session-a", action: "stop" },
  ])("rejects mutation/operator frame $type", frame => {
    const s = source();
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: s.value });
    const transport = new FakeTransport();
    bridge.attach(transport);
    transport.emit(frame);
    expect(transport.sent).toEqual([{ type: "phone_projection_error", version: 1, code: "invalid_request" }]);
    expect(s.value.subscribe).not.toHaveBeenCalled();
  });

  it("redacts snapshot and live output, then replays it in sequence after reconnect", () => {
    const secret = "sk_live_123456789012345678901234";
    const s = source([{ kind: "conversation", role: "assistant", text: `saved ${secret}` }]);
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: s.value });
    const first = new FakeTransport();
    bridge.attach(first);
    subscribe(first);
    expect(JSON.stringify(first.sent[0])).not.toContain(secret);
    s.emit("session-a", { kind: "output", text: `answer ${secret}`, replace: false });
    s.emit("session-a", { kind: "status", state: "done" });
    expect(first.sent.slice(1).map(frame => frame.seq)).toEqual([1, 2]);
    expect(JSON.stringify(first.sent)).not.toContain(secret);

    first.close();
    const second = new FakeTransport();
    bridge.attach(second);
    subscribe(second, "session-a", 0);
    expect(second.sent.map(frame => frame.seq)).toEqual([1, 2]);
  });

  it("subscribes before a cursorless durable snapshot and flushes concurrent live frames after it", () => {
    const live: { listener: ((item: PhoneProjectionItem) => void) | null } = { listener: null };
    const value: PhoneProjectionSource = {
      subscribe: (_sessionId, next) => {
        live.listener = next;
        return () => { live.listener = null; };
      },
      snapshot: () => {
        live.listener?.({ kind: "output", text: "arrived during snapshot", replace: false });
        return [{ kind: "conversation", role: "assistant", text: "durable base" }];
      },
    };
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: value });
    const transport = new FakeTransport();
    bridge.attach(transport);
    subscribe(transport);
    expect(transport.sent.map(frame => frame.type)).toEqual([
      "phone_projection_snapshot",
      "phone_projection_event",
    ]);
    expect(transport.sent[1]).toMatchObject({ seq: 1, item: { text: "arrived during snapshot" } });
  });

  it.each<PhoneProjectionItem>([
    { kind: "operation", opId: "op-race", status: "running", progress: "turn 2" },
    { kind: "conversation", role: "assistant", text: "persisted answer" },
    { kind: "output", text: "persisted answer", replace: true },
  ])("uses exact snapshot coverage to emit a concurrent $kind update exactly once", (item) => {
    const live: { listener: ((next: PhoneProjectionItem, version?: number) => void) | null } = { listener: null };
    const value: PhoneProjectionSource = {
      subscribe: (_sessionId, next) => { live.listener = next; return () => { live.listener = null; }; },
      snapshot: () => {
        live.listener?.(item, 1);
        return { items: [item], coveredVersions: [1] };
      },
    };
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: value });
    const transport = new FakeTransport();
    bridge.attach(transport);
    subscribe(transport);
    expect(transport.sent).toEqual([
      expect.objectContaining({ type: "phone_projection_snapshot", items: [item] }),
    ]);

    live.listener?.(item, 2);
    expect(transport.sent.at(-1)).toMatchObject({ type: "phone_projection_event", seq: 1, item });
  });

  it.each<PhoneProjectionItem>([
    { kind: "operation", opId: "op-window", status: "running", progress: "after read" },
    { kind: "conversation", role: "assistant", text: "after read" },
    { kind: "output", text: "after read", replace: true },
  ])("does not omit a concurrent $kind event absent from the snapshot", item => {
    const live: { listener: ((next: PhoneProjectionItem, version?: number) => void) | null } = { listener: null };
    const value: PhoneProjectionSource = {
      highWater: () => 0,
      subscribe: (_sessionId, next) => { live.listener = next; return () => { live.listener = null; }; },
      snapshot: () => {
        live.listener?.(item, 1);
        return { items: [], coveredVersions: [] };
      },
    };
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: value });
    const transport = new FakeTransport();
    bridge.attach(transport);
    subscribe(transport);
    expect(transport.sent.map(frame => frame.type)).toEqual([
      "phone_projection_snapshot",
      "phone_projection_event",
    ]);
    expect(transport.sent[1]).toMatchObject({ seq: 1, item });
  });

  it("never treats ephemeral progress as covered by a durable operation snapshot", () => {
    const items: PhoneProjectionItem[] = [{ kind: "operation", opId: "op-progress", status: "running" }];
    const event = { type: "bg_op_progress", opId: "op-progress", line: "fresh progress" } as const;
    expect(snapshotCoveredVersions(items, [{ event, version: 7 }])).toEqual([]);

    const live: { listener: ((next: PhoneProjectionItem, version?: number) => void) | null } = { listener: null };
    const value: PhoneProjectionSource = {
      highWater: () => 6,
      subscribe: (_sessionId, next) => { live.listener = next; return () => { live.listener = null; }; },
      snapshot: () => {
        live.listener?.({ kind: "operation", opId: "op-progress", status: "running", progress: "fresh progress" }, 7);
        return { items, coveredVersions: [] };
      },
    };
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: value });
    const transport = new FakeTransport();
    bridge.attach(transport);
    subscribe(transport);
    expect(transport.sent.at(-1)).toMatchObject({
      type: "phone_projection_event",
      item: { kind: "operation", progress: "fresh progress" },
    });
  });
  it("invalidates a failed session replay identity before binding another session", () => {
    const listeners = new Map<string, (item: PhoneProjectionItem, version?: number) => void>();
    let failSessionARecovery = false;
    let throwOnUnsubscribe = false;
    const value: PhoneProjectionSource = {
      subscribe: (sessionId, next) => {
        listeners.set(sessionId, next);
        return () => { listeners.delete(sessionId); if (throwOnUnsubscribe) throw new Error("unsubscribe failed"); };
      },
      snapshot: sessionId => {
        if (sessionId === "session-a" && failSessionARecovery) throw new Error("snapshot failed");
        return [{ kind: "conversation", role: "assistant", text: `${sessionId} base` }];
      },
    };
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: value });
    const firstA = new FakeTransport();
    bridge.attach(firstA);
    subscribe(firstA, "session-a");
    for (let i = 1; i <= 130; i += 1) {
      listeners.get("session-a")?.({ kind: "output", text: `session A ${i}`, replace: false }, i);
    }
    firstA.close();
    failSessionARecovery = throwOnUnsubscribe = true;
    const recoveringA = new FakeTransport();
    bridge.attach(recoveringA);
    subscribe(recoveringA, "session-a", 0);
    expect(recoveringA.sent.map(frame => frame.code)).toEqual(["replay_expired", "snapshot_unavailable"]);
    expect(listeners.size).toBe(0);
    failSessionARecovery = throwOnUnsubscribe = false;
    subscribe(recoveringA, "session-a", 0);
    expect(recoveringA.sent.at(-1)).toMatchObject({ type: "phone_projection_snapshot",
      sessionId: "session-a", seq: 0, items: [{ text: "session-a base" }] });
    failSessionARecovery = true;
    subscribe(recoveringA, "session-a", 0);
    expect(recoveringA.sent.at(-1)).toMatchObject({ code: "snapshot_unavailable" });
    expect(listeners.size).toBe(0);
    recoveringA.close();
    const firstB = new FakeTransport();
    bridge.attach(firstB);
    subscribe(firstB, "session-b", 130);
    expect(firstB.sent.map(frame => frame.type)).toEqual(["phone_projection_error", "phone_projection_snapshot"]);
    expect(firstB.sent[1]).toMatchObject({ sessionId: "session-b", seq: 0,
      items: [{ kind: "conversation", role: "assistant", text: "session-b base" }] });
    expect(JSON.stringify(firstB.sent)).not.toContain("session A");
    listeners.get("session-b")?.({ kind: "output", text: "session B live", replace: false }, 1);
    expect(firstB.sent.at(-1)).toMatchObject({ sessionId: "session-b", seq: 1 });
    firstB.close();
    const replayingB = new FakeTransport();
    bridge.attach(replayingB);
    subscribe(replayingB, "session-b", 0);
    expect(replayingB.sent).toEqual([expect.objectContaining({
      type: "phone_projection_event", sessionId: "session-b", seq: 1,
      item: { kind: "output", text: "session B live", replace: false },
    })]);
  });
  it("snapshots durable state for cursor zero on a fresh bridge", () => {
    const durable = { kind: "conversation", role: "assistant", text: "recovered base" } as const;
    const s = source([durable]);
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: s.value });
    const transport = new FakeTransport();
    bridge.attach(transport);
    subscribe(transport, "session-a", 0);
    expect(transport.sent).toEqual([expect.objectContaining({
      type: "phone_projection_snapshot", sessionId: "session-a", seq: 0, items: [durable],
    })]);
    s.emit("session-a", { kind: "status", state: "started" });
    expect(transport.sent.at(-1)).toMatchObject({ type: "phone_projection_event", seq: 1 });
  });
  it("orders replay before a live frame that arrives while cursor reconnect is attaching", () => {
    const live: { listener: ((item: PhoneProjectionItem) => void) | null } = { listener: null };
    let subscriptions = 0;
    const value: PhoneProjectionSource = {
      snapshot: () => [],
      subscribe: (_sessionId, next) => {
        live.listener = next;
        subscriptions += 1;
        if (subscriptions === 2) next({ kind: "output", text: "during reconnect", replace: false });
        return () => { live.listener = null; };
      },
    };
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: value });
    const first = new FakeTransport();
    bridge.attach(first);
    subscribe(first);
    live.listener?.({ kind: "output", text: "before disconnect", replace: false });
    first.close();

    const second = new FakeTransport();
    bridge.attach(second);
    subscribe(second, "session-a", 0);
    expect(second.sent.map(frame => frame.seq)).toEqual([1, 2]);
    expect(second.sent.map(frame => (frame.item as { text?: string }).text)).toEqual([
      "before disconnect",
      "during reconnect",
    ]);
  });

  it("ignores stale transport close and message callbacks after a replacement attaches", () => {
    const s = source();
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: s.value });
    const stale = new FakeTransport();
    const current = new FakeTransport();
    bridge.attach(stale);
    bridge.attach(current);
    stale.emit({ type: "phone_projection_subscribe", deviceId: "phone-1", sessionId: "wrong" });
    subscribe(current, "session-a");
    stale.close();
    s.emit("session-a", { kind: "output", text: "still attached", replace: false });
    expect(stale.sent).toEqual([]);
    expect(current.sent.at(-1)).toMatchObject({
      type: "phone_projection_event",
      sessionId: "session-a",
      item: { text: "still attached" },
    });
  });

  it("falls back to a bounded snapshot when the replay cursor has expired", () => {
    const s = source([{ kind: "status", state: "done" }]);
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: s.value });
    const first = new FakeTransport();
    bridge.attach(first);
    subscribe(first);
    for (let i = 0; i < 130; i += 1) s.emit("session-a", { kind: "output", text: String(i), replace: false });
    first.close();

    const second = new FakeTransport();
    bridge.attach(second);
    subscribe(second, "session-a", 0);
    expect(second.sent[0]).toEqual({ type: "phone_projection_error", version: 1, code: "replay_expired" });
    expect(second.sent[1]).toMatchObject({ type: "phone_projection_snapshot", sessionId: "session-a", seq: 130 });
  });

  it("reconciles the same concurrent output across an expired-cursor snapshot boundary", () => {
    const duplicate: PhoneProjectionItem = { kind: "output", text: "durable final", replace: true };
    const live: { listener: ((item: PhoneProjectionItem, version?: number) => void) | null } = { listener: null };
    let snapshotCount = 0;
    const value: PhoneProjectionSource = {
      subscribe: (_sessionId, next) => { live.listener = next; return () => { live.listener = null; }; },
      snapshot: () => {
        snapshotCount += 1;
        if (snapshotCount === 1) return { items: [], coveredVersions: [] };
        live.listener?.(duplicate, 131);
        return { items: [duplicate], coveredVersions: [131] };
      },
    };
    const bridge = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: value });
    const first = new FakeTransport();
    bridge.attach(first);
    subscribe(first);
    for (let version = 1; version <= 130; version += 1) {
      live.listener?.({ kind: "output", text: String(version), replace: false }, version);
    }
    first.close();

    const second = new FakeTransport();
    bridge.attach(second);
    subscribe(second, "session-a", 0);
    expect(second.sent.map(frame => frame.type)).toEqual([
      "phone_projection_error",
      "phone_projection_snapshot",
    ]);
    expect(second.sent[1]).toMatchObject({ items: [duplicate], seq: 130 });
    live.listener?.(duplicate, 132);
    expect(second.sent.at(-1)).toMatchObject({ type: "phone_projection_event", seq: 131, item: duplicate });
  });

  it("rebuilds an ordered read model from canonical snapshot state after process restart", () => {
    const items: PhoneProjectionItem[] = [
      { kind: "conversation", role: "user", text: "build it" },
      { kind: "conversation", role: "assistant", text: "working" },
      { kind: "operation", opId: "op-1", status: "running", progress: "step 2" },
      { kind: "notification", opId: "op-0", status: "completed", summary: "earlier work done" },
    ];
    const restartedSource = source(items);
    const restarted = new PhoneProjectionBridge({ pairedPhoneId: "phone-1", source: restartedSource.value });
    const transport = new FakeTransport();
    restarted.attach(transport);
    subscribe(transport);
    expect(transport.sent[0]).toMatchObject({ type: "phone_projection_snapshot", seq: 0, items });
  });

  it("reconstructs current operation state and latest progress from durable restart facts", () => {
    const op = {
      id: "op-restart",
      sessionId: "session-a",
      task: "repair all blockers",
      status: "running",
      canonical: { state: "running" },
    } as Op;
    const item = projectDurableOperation(op, {
      turns: [{
        opId: op.id,
        turnIdx: 7,
        toolCallSummary: [{ tool: "apply_patch", resultStatus: "ok" }],
      } as never],
      checkpoint: null,
      finalText: "",
    });
    expect(item).toEqual({
      kind: "operation",
      opId: "op-restart",
      status: "running",
      task: "repair all blockers",
      progress: "turn 7 · apply_patch",
    });
  });
});
