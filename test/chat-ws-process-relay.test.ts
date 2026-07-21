import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(join(process.cwd(), "public/js/chat-ws-process-relay.js"), "utf8");
const bgSource = readFileSync(join(process.cwd(), "public/js/chat-ws-handler-bg-ops.js"), "utf8");
const handlerSource = readFileSync(join(process.cwd(), "public/js/chat-ws-handler.js"), "utf8");

describe("chat process relay delivery", () => {
  it("ACKs only after every nested event dispatches", () => {
    const harness = createHarness();
    const dispatch = vi.fn((value: unknown) => {
      if ((value as { event?: { type?: string } }).event?.type === "error") throw new Error("render failed");
      return true;
    });
    const delivery = envelope([{ type: "worker_done", opId: "op", status: "completed" },
      { type: "error", message: "boom" }]);
    expect(harness.handle(delivery, dispatch)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(harness.sent).toEqual([]);
    expect(harness.storage.getItem("lax-process-relay-events-seen-v1")).not.toBeNull();
  });

  it("does not re-apply a completed delivery after reload but ACKs it again", () => {
    const storage = memoryStorage();
    const first = createHarness(storage);
    const delivery = envelope([{ type: "worker_done", opId: "op", status: "completed" }]);
    const firstDispatch = vi.fn(() => true);
    first.handle(delivery, firstDispatch);
    expect(firstDispatch).toHaveBeenCalledOnce();
    expect(first.sent).toHaveLength(1);

    const reloaded = createHarness(storage);
    const secondDispatch = vi.fn(() => true);
    reloaded.handle(delivery, secondDispatch);
    expect(secondDispatch).not.toHaveBeenCalled();
    expect(reloaded.sent).toHaveLength(1);
  });

  it("renders global-only projections without acknowledging the full record", () => {
    const harness = createHarness();
    const delivery = { ...envelope([{ type: "bg_op_completed", opId: "op", status: "completed" }]),
      deliveryId: `${"a".repeat(64)}:1:global`, ackRequired: false };
    const dispatch = vi.fn(() => true);
    harness.handle(delivery, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(harness.sent).toEqual([]);
  });

  it("does not reapply a global subset when the subscribed client later receives the full record", () => {
    const harness = createHarness();
    const full = envelope([
      { type: "bg_op_completed", opId: "op", status: "completed" },
      { type: "worker_done", opId: "op", status: "completed" },
    ]);
    const global = { ...full, ackRequired: false, events: [full.events[0]], eventIds: [full.eventIds[0]] };
    const applied: string[] = [];
    const dispatch = vi.fn((value: { event: { type: string } }) => { applied.push(value.event.type); return true; });
    harness.handle(global, dispatch);
    harness.handle(full, dispatch);
    expect(applied).toEqual(["bg_op_completed", "worker_done"]);
    expect(harness.sent).toHaveLength(1);
  });

  it("withholds ACK when a background handler swallows a reducer failure", () => {
    const sent: string[] = [];
    const factory = new Function("localStorage", "sent", `
      var WebSocket = { OPEN: 1 };
      var chatWs = { readyState: 1, send: function(value) { sent.push(value); } };
      var addAgentFeed = function() { throw new Error('paint failed'); };
      ${bgSource}
      ${source}
      return { handleProcessRelayDelivery, dispatchBgOpEventChecked };
    `);
    const api = factory(memoryStorage(), sent) as {
      handleProcessRelayDelivery: (value: unknown, dispatch: (value: unknown) => boolean) => boolean;
      dispatchBgOpEventChecked: (value: unknown) => boolean | null;
    };
    api.handleProcessRelayDelivery(envelope([{ type: "bg_op_queued", opId: "op", task: "x" }]),
      value => api.dispatchBgOpEventChecked(value) === true);
    expect(sent).toEqual([]);
  });

  it("withholds ACK and seen persistence when inject reconciliation throws", () => {
    const storage = memoryStorage();
    const sent: string[] = [];
    const factory = new Function("localStorage", "sent", `
      var WebSocket = { OPEN: 1 };
      var chatWs = { readyState: 1, send: function(value) { sent.push(value); } };
      var window = {};
      var activeChat = null;
      var ChatStreamStore = {
        consumeInject: function() { throw new Error('store failed'); },
        bumpActivity: function() {},
      };
      ${source}
      ${handlerSource}
      return { handleProcessRelayDelivery, dispatchProcessRelayEvent };
    `);
    const api = factory(storage, sent) as {
      handleProcessRelayDelivery: (value: unknown, dispatch: (value: unknown) => boolean) => boolean;
      dispatchProcessRelayEvent: (value: unknown) => boolean;
    };
    const delivery = envelope([{ type: "inject_consumed", injectId: "inj-1", message: "continue" }]);
    expect(api.handleProcessRelayDelivery(delivery, api.dispatchProcessRelayEvent)).toBe(true);
    expect(sent).toEqual([]);
    expect(storage.getItem("lax-process-relay-events-seen-v1")).toBeNull();
  });

  it("ACKs a successfully reconciled inject no-op", () => {
    const storage = memoryStorage();
    const sent: string[] = [];
    const factory = new Function("localStorage", "sent", `
      var WebSocket = { OPEN: 1 };
      var chatWs = { readyState: 1, send: function(value) { sent.push(value); } };
      var window = {};
      var activeChat = null;
      var ChatStreamStore = {
        consumeInject: function() { return false; },
        bumpActivity: function() {},
      };
      ${source}
      ${handlerSource}
      return { handleProcessRelayDelivery, dispatchProcessRelayEvent };
    `);
    const api = factory(storage, sent) as {
      handleProcessRelayDelivery: (value: unknown, dispatch: (value: unknown) => boolean) => boolean;
      dispatchProcessRelayEvent: (value: unknown) => boolean;
    };
    const delivery = envelope([{ type: "inject_consumed", injectId: "already-gone" }]);
    api.handleProcessRelayDelivery(delivery, api.dispatchProcessRelayEvent);
    expect(sent).toHaveLength(1);
    expect(storage.getItem("lax-process-relay-events-seen-v1")).not.toBeNull();
  });
});

function createHarness(storage = memoryStorage()) {
  const sent: string[] = [];
  const factory = new Function("localStorage", "sent", `
    var WebSocket = { OPEN: 1 };
    var chatWs = { readyState: 1, send: function(value) { sent.push(value); } };
    ${source}
    return { handleProcessRelayDelivery };
  `);
  const api = factory(storage, sent) as {
    handleProcessRelayDelivery: (value: unknown, dispatch: (value: unknown) => void) => boolean;
  };
  return { handle: api.handleProcessRelayDelivery, sent, storage };
}

function envelope(events: unknown[]) {
  return { type: "process_relay_delivery", opId: "op", sessionId: "session",
    generationId: "a".repeat(64), cursor: 1, deliveryId: `${"a".repeat(64)}:1`, events,
    eventIds: events.map((_event, index) => `${"a".repeat(64)}:1:${index}`) };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
