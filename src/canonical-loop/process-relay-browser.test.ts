import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { Op } from "../ops/types.js";
import type { ProcessRelayBrowserAck } from "./process-relay-contract.js";

const priorDataDir = process.env.LAX_DATA_DIR;
const priorAuditKey = process.env.LAX_AUDIT_KEY;
const dataDir = mkdtempSync(join(tmpdir(), "lax-relay-browser-"));
process.env.LAX_DATA_DIR = dataDir;
process.env.LAX_AUDIT_KEY = "relay-browser-test-key";

const { writeOp } = await import("../ops/op-store.js");
const { clients } = await import("../chat-ws/state.js");
const { claimProcessExecution, removeProcessExecutionClaim } = await import("./process-execution-claim.js");
const { getBus, streamChannel } = await import("./bus.js");
const { setSessionBroadcaster } = await import("../ops/session-bridge.js");
const { subscribeSessionEvents } = await import("../chat-ws/session-event-observers.js");
const { appendProcessRelayRecord, initializeProcessRelayJournal, readProcessRelayGenerations } =
  await import("./process-relay-journal.js");
const {
  acknowledgeBrowserProcessRelay,
  reconcileAllPendingProcessRelays,
  reconcilePendingProcessRelay,
  reconcilePendingProcessRelaysInBackground,
} = await import("./process-relay-browser.js");

afterEach(() => {
  clients.clear();
  setSessionBroadcaster(() => {});
});
afterAll(() => {
  if (priorDataDir === undefined) delete process.env.LAX_DATA_DIR;
  else process.env.LAX_DATA_DIR = priorDataDir;
  if (priorAuditKey === undefined) delete process.env.LAX_AUDIT_KEY;
  else process.env.LAX_AUDIT_KEY = priorAuditKey;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("process relay browser delivery", () => {
  it("keeps output pending offline, replays on reconnect, and accepts only the exact ACK", () => {
    const fixture = createFixture("global");
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "canonical-event", {
      opId: fixture.opId,
      seq: 0,
      type: "state_changed",
      ts: new Date().toISOString(),
      body: { from: null, to: "queued", reason: "submitted" },
    });
    expect(reconcilePendingProcessRelay(fixture.opId)).toBe(2);
    expect(ackTargets(fixture.opId)).toEqual(["canonical-core", "session-observer"]);

    const socket = attachClient([]);
    reconcileAllPendingProcessRelays();
    const delivery = JSON.parse(socket.send.mock.calls[0][0]) as ProcessRelayBrowserAck & { events: unknown[] };
    expect(delivery.deliveryId).toBe(`${delivery.generationId}:1`);
    expect(delivery.events).toHaveLength(1);
    expect(acknowledgeBrowserProcessRelay({ ...delivery, sessionId: "wrong" }, false)).toBe(false);
    expect(acknowledgeBrowserProcessRelay({ ...delivery, cursor: 2 }, false)).toBe(false);
    expect(acknowledgeBrowserProcessRelay({ ...delivery, deliveryId: "wrong" }, false)).toBe(false);
    expect(acknowledgeBrowserProcessRelay(delivery, false)).toBe(true);
    expect(ackTargets(fixture.opId).sort()).toEqual(["browser-render", "canonical-core", "session-observer"]);
    expect(acknowledgeBrowserProcessRelay(delivery, false)).toBe(true);
  });

  it("does not expose session-scoped records until that session subscribes", () => {
    const fixture = createFixture("session");
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "session-event", {
      type: "worker_done", opId: fixture.opId, status: "completed", summary: "done",
    });
    const socket = attachClient([]);
    reconcilePendingProcessRelay(fixture.opId);
    expect(socket.send).not.toHaveBeenCalled();
    clients.set(socket as unknown as WebSocket, new Set([fixture.sessionId]));
    reconcileAllPendingProcessRelays(fixture.sessionId);
    expect(socket.send).toHaveBeenCalledOnce();
    const delivery = JSON.parse(socket.send.mock.calls[0][0]) as ProcessRelayBrowserAck;
    expect(acknowledgeBrowserProcessRelay(delivery, false)).toBe(false);
    expect(acknowledgeBrowserProcessRelay(delivery, true)).toBe(true);
  });

  it("publishes rapid stream records on the parent bus without per-token browser delivery", () => {
    const fixture = createFixture("stream");
    const chunks: unknown[] = [];
    const off = getBus().subscribe(streamChannel(fixture.opId), value => chunks.push(value));
    const progress: unknown[] = [];
    setSessionBroadcaster((_sessionId, event) => progress.push(event));
    const socket = attachClient([fixture.sessionId]);
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "canonical-event", {
      opId: fixture.opId, seq: 0, type: "state_changed", ts: new Date().toISOString(),
      body: { from: null, to: "queued", reason: "submitted" },
    });
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "stream-chunk", { delta: "one" });
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "stream-chunk", { delta: "two" });
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "stream-chunk", { delta: "three" });
    expect(reconcilePendingProcessRelay(fixture.opId)).toBe(5);
    off();
    expect(chunks).toEqual([{ delta: "one" }, { delta: "two" }, { delta: "three" }]);
    // op_stream reaches the parent bus and STOPS there. A 250ms sampler used to
    // turn the first chunk of each tick into a bg_op_progress row for the AGENTS
    // sidebar; that channel carries model tokens, so it could only ever emit a
    // sentence fragment — 588 rows for ~12 real actions — and it was removed in
    // d423007e. The sidebar's content is the canonical events. This assertion is
    // now what keeps the sampler from coming back.
    expect(progress).toEqual([]);
    expect(socket.send).toHaveBeenCalledOnce();
    const delivery = JSON.parse(socket.send.mock.calls[0][0]) as { events: Array<{ type: string }> };
    expect(delivery.events.map(event => event.type)).toEqual(["bg_op_queued"]);
    expect(readProcessRelayGenerations(fixture.opId)[0].records.slice(1)
      .every(record => record.targets.length === 1 && record.targets[0] === "canonical-core")).toBe(true);
    expect(ackTargets(fixture.opId, 2)).toEqual(["canonical-core"]);
  });

  it("notifies session observers exactly once while browser replay remains pending", () => {
    const fixture = createFixture("observer-once");
    const observed: unknown[] = [];
    const off = subscribeSessionEvents(fixture.sessionId, event => observed.push(event));
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "session-event", {
      type: "worker_done", opId: fixture.opId, status: "completed", summary: "done",
    });
    const socket = attachClient([fixture.sessionId]);
    reconcilePendingProcessRelay(fixture.opId);
    reconcilePendingProcessRelay(fixture.opId);
    expect(observed).toEqual([expect.objectContaining({ type: "worker_done", opId: fixture.opId })]);
    expect(socket.send).toHaveBeenCalledTimes(2);
    const delivery = JSON.parse(socket.send.mock.calls[1][0]) as ProcessRelayBrowserAck;
    expect(acknowledgeBrowserProcessRelay(delivery, true)).toBe(true);
    expect(observed).toHaveLength(1);
    off();
  });

  it("preserves global bg-op routing while session clients receive the complete record", () => {
    const fixture = createFixture("mixed");
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "canonical-event", {
      opId: fixture.opId, seq: 0, type: "state_changed", ts: new Date().toISOString(),
      body: { from: "running", to: "succeeded", reason: "done" },
    });
    const globalSocket = attachClient([]);
    const sessionSocket = attachClient([fixture.sessionId]);
    reconcilePendingProcessRelay(fixture.opId);
    const globalDelivery = JSON.parse(globalSocket.send.mock.calls[0][0]) as {
      deliveryId: string; ackRequired: boolean; events: Array<{ type: string }>;
    };
    const sessionDelivery = JSON.parse(sessionSocket.send.mock.calls[0][0]) as ProcessRelayBrowserAck & {
      events: Array<{ type: string }>;
    };
    expect(globalDelivery.deliveryId).toBe(sessionDelivery.deliveryId);
    expect(globalDelivery.ackRequired).toBe(false);
    expect(globalDelivery.events.map(event => event.type)).toEqual(["bg_op_completed"]);
    expect(sessionDelivery.events.map(event => event.type))
      .toEqual(["bg_op_completed", "worker_done"]);
    expect(acknowledgeBrowserProcessRelay(sessionDelivery, false)).toBe(false);
    expect(acknowledgeBrowserProcessRelay(sessionDelivery, true)).toBe(true);
  });
});

// A record is owed to the tabs only as far as some tab can receive it. One with
// nothing for any tab is not sent and not waited on, so a journal made only of
// those completes; before, each waited for a tab subscribed to its session, and
// a headless session (mail watch, failure review, dream) never has one.
describe("a relay record with nothing for any tab", () => {
  const workerDone = (opId: string) => ({ type: "worker_done", opId, status: "completed", summary: "done" });
  const canonical = (opId: string, type: string, body: Record<string, unknown>) => ({
    opId, seq: 0, type, ts: new Date().toISOString(), body,
  });

  it("an event that has no browser form is done once the server has it, in any session", () => {
    const fixture = createFixture("no-browser-form");
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "canonical-event",
      canonical(fixture.opId, "turn_started", { turnIdx: 0 }));
    const socket = attachClient([fixture.sessionId]);
    expect(reconcilePendingProcessRelay(fixture.opId)).toBe(3);
    expect(ackTargets(fixture.opId).sort()).toEqual(["browser-render", "canonical-core", "session-observer"]);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it("a headless session's own event reaches its observers and no tab, and its journal goes once the worker lets go", () => {
    const fixture = createFixture("headless", "mail-watch-abc123");
    const observed: unknown[] = [];
    const off = subscribeSessionEvents(fixture.sessionId, event => observed.push(event));
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "session-event", workerDone(fixture.opId));
    const socket = attachClient([fixture.sessionId]);
    expect(reconcilePendingProcessRelay(fixture.opId)).toBe(2);
    expect(ackTargets(fixture.opId).sort()).toEqual(["browser-render", "session-observer"]);
    off();
    expect(observed).toEqual([expect.objectContaining({ type: "worker_done" })]);
    expect(socket.send).not.toHaveBeenCalled();
    expect(existsSync(relayFolder(fixture.opId))).toBe(true); // the worker still holds its claim
    removeProcessExecutionClaim(fixture.claim);
    reconcilePendingProcessRelay(fixture.opId);
    expect(existsSync(relayFolder(fixture.opId))).toBe(false);
  });

  it("a headless session's batch is its global events alone, which any tab acknowledges", () => {
    const fixture = createFixture("headless-global", "dream-abc123");
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "canonical-event",
      canonical(fixture.opId, "state_changed", { from: "running", to: "succeeded", reason: "done" }));
    const socket = attachClient([]);
    reconcilePendingProcessRelay(fixture.opId);
    const delivery = JSON.parse(socket.send.mock.calls[0][0]) as ProcessRelayBrowserAck & {
      scope: string; ackRequired?: boolean; events: Array<{ type: string }>; eventIds: string[];
    };
    expect(delivery.scope).toBe("global");
    expect(delivery.ackRequired).not.toBe(false);
    expect(delivery.events.map(event => event.type)).toEqual(["bg_op_completed"]);
    expect(delivery.eventIds).toEqual([`${delivery.deliveryId}:0`]);
    expect(acknowledgeBrowserProcessRelay(delivery, false)).toBe(true);
    expect(ackTargets(fixture.opId).sort()).toEqual(["browser-render", "canonical-core", "session-observer"]);
  });

  it("a session with tabs still waits for one of its tabs: the journal stays until it acknowledges", () => {
    const fixture = createFixture("with-tabs", "chat-has-tabs");
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "session-event", workerDone(fixture.opId));
    attachClient([]);
    reconcilePendingProcessRelay(fixture.opId);
    expect(ackTargets(fixture.opId)).toEqual(["session-observer"]);
    removeProcessExecutionClaim(fixture.claim);
    reconcilePendingProcessRelay(fixture.opId);
    expect(existsSync(relayFolder(fixture.opId))).toBe(true);
  });
});

// A chat connection and a subscription ask for the pass without holding the
// thread: it runs one op at a time and gives the event loop a turn between.
describe("the background pass over pending relays", () => {
  const stateChanged = (opId: string) => ({
    opId, seq: 0, type: "state_changed", ts: new Date().toISOString(),
    body: { from: null, to: "queued", reason: "submitted" },
  });

  it("delivers what is pending to a page that has connected, as the all-at-once pass does", async () => {
    const fixture = createFixture("background-all");
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "canonical-event", stateChanged(fixture.opId));
    const socket = attachClient([]);
    await reconcilePendingProcessRelaysInBackground();
    const sent = socket.send.mock.calls.map((call) => JSON.parse(call[0]) as ProcessRelayBrowserAck);
    expect(sent.filter((d) => d.opId === fixture.opId)).toHaveLength(1);
    expect(ackTargets(fixture.opId)).toEqual(["canonical-core", "session-observer"]);
  });

  it("reaches a session's records when asked for that session", async () => {
    const fixture = createFixture("background-session");
    appendProcessRelayRecord(fixture.claim, fixture.sessionId, "session-event", {
      type: "worker_done", opId: fixture.opId, status: "completed", summary: "done",
    });
    const socket = attachClient([fixture.sessionId]);
    await reconcilePendingProcessRelaysInBackground("some-other-session");
    expect(socket.send.mock.calls.filter((call) => (JSON.parse(call[0]) as ProcessRelayBrowserAck).opId === fixture.opId)).toHaveLength(0);
    await reconcilePendingProcessRelaysInBackground(fixture.sessionId);
    expect(socket.send.mock.calls.filter((call) => (JSON.parse(call[0]) as ProcessRelayBrowserAck).opId === fixture.opId)).toHaveLength(1);
  });

  it("runs one pass at a time, and a request made during it gets a pass of its own after", async () => {
    const early = createFixture("background-early");
    appendProcessRelayRecord(early.claim, early.sessionId, "canonical-event", stateChanged(early.opId));
    const first = reconcilePendingProcessRelaysInBackground();
    // A page that connects after the pass has started: nothing has been sent to it yet.
    const late = attachClient([]);
    const second = reconcilePendingProcessRelaysInBackground();
    expect(second).toBe(first);
    await second;
    const toLate = late.send.mock.calls.map((call) => JSON.parse(call[0]) as ProcessRelayBrowserAck);
    expect(toLate.some((d) => d.opId === early.opId)).toBe(true);
    // The pass has ended: the next request starts a new one.
    expect(reconcilePendingProcessRelaysInBackground()).not.toBe(first);
  });
});

function relayFolder(opId: string): string {
  return join(dataDir, "operations", opId, "process-relay");
}

function createFixture(label: string, sessionId = `session-${label}`) {
  const opId = `op-browser-${label}-${Math.random().toString(16).slice(2)}`;
  const now = new Date().toISOString();
  const op = {
    id: opId, type: "delegated_task", task: label, model: "test", lane: "background",
    retryPolicy: { maxRecoveryAttempts: 1, backoffMs: [0] }, ownerId: "test",
    visibility: "private", status: "pending", createdAt: now, updatedAt: now, attemptCount: 0,
    canonical: { state: "running", sessionId, executionPlacement: {
      schemaVersion: 1, backendId: "local-process", targetId: "canonical-worker-process-v1",
      disposition: "ready", wakeToken: null, wakeRequestedAt: null, revision: 1,
    } },
  } as unknown as Op;
  writeOp(op);
  const claim = { schemaVersion: 1 as const, opId, backendId: "local-process",
    targetId: "canonical-worker-process-v1", placementRevision: 1, token: `token-${label}`,
    pid: process.pid, processStartedAt: now, heartbeatAt: now };
  expect(claimProcessExecution(claim)).toBe(true);
  initializeProcessRelayJournal(claim, sessionId);
  return { opId, sessionId, claim };
}

function attachClient(subscriptions: string[]) {
  const socket = { readyState: 1, send: vi.fn() };
  clients.set(socket as unknown as WebSocket, new Set(subscriptions));
  return socket;
}

function ackTargets(opId: string, cursor = 1): string[] {
  return [...readProcessRelayGenerations(opId)[0].acknowledgements.get(cursor) ?? []];
}
