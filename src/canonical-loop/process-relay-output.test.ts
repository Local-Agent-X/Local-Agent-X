import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessRelayRecord } from "./process-relay-contract.js";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  publish: vi.fn(),
  canonicalMetric: vi.fn(),
  streamMetric: vi.fn(),
  bridge: vi.fn(),
  cost: vi.fn(),
}));

vi.mock("./store.js", () => ({
  appendCanonicalEvent: mocks.append,
  appendCanonicalEventStrict: mocks.append,
}));
vi.mock("./bus.js", () => ({
  getBus: () => ({ publish: mocks.publish }),
  eventsChannel: (opId: string) => `events:${opId}`,
  streamChannel: (opId: string) => `stream:${opId}`,
}));
vi.mock("./soak-metrics.js", () => ({
  recordCanonicalEvent: mocks.canonicalMetric,
  recordStreamChunk: mocks.streamMetric,
}));
vi.mock("./session-bridge-observer.js", () => ({ recordCanonicalEvent: mocks.bridge }));
vi.mock("./cost-recording.js", () => ({ recordCostEvent: mocks.cost }));

const { emit, publishStreamChunk } = await import("./event-emitter.js");
const { setProcessRelayOutputWriter } = await import("./process-relay-output.js");
const { projectProcessRelayTarget } = await import("./process-relay-reconcile.js");

beforeEach(() => {
  vi.clearAllMocks();
  setProcessRelayOutputWriter(null);
  mocks.append.mockReturnValue({
    opId: "op-1",
    seq: 1,
    type: "turn_started",
    ts: "2026-07-21T00:00:00.000Z",
    body: null,
  });
});

describe("process relay output injection", () => {
  it("leaves normal in-process projection unchanged", () => {
    const event = emit("op-1", "turn_started");
    expect(mocks.publish).toHaveBeenCalledWith("events:op-1", event);
    expect(mocks.canonicalMetric).toHaveBeenCalledWith(event);
    expect(mocks.bridge).toHaveBeenCalledWith(event);
    expect(mocks.cost).toHaveBeenCalledWith(event);
    publishStreamChunk("op-1", { delta: "hello" });
    expect(mocks.publish).toHaveBeenCalledWith("stream:op-1", { delta: "hello" });
    expect(mocks.streamMetric).toHaveBeenCalledWith("op-1");
  });

  it("persists canonical and stream output while suppressing child-local projection", () => {
    const relayed: Array<{ kind: string; payload: unknown }> = [];
    setProcessRelayOutputWriter((kind, payload) => {
      relayed.push({ kind, payload });
      return { type: "process-relay", opId: "op-1", generationId: "a".repeat(64), cursor: relayed.length };
    });
    const event = emit("op-1", "turn_started");
    publishStreamChunk("op-1", { delta: "hello" });
    expect(relayed).toEqual([
      { kind: "canonical-event", payload: event },
      { kind: "stream-chunk", payload: { delta: "hello" } },
    ]);
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.canonicalMetric).not.toHaveBeenCalled();
    expect(mocks.bridge).not.toHaveBeenCalled();
    expect(mocks.cost).not.toHaveBeenCalled();
    expect(mocks.streamMetric).not.toHaveBeenCalled();
  });

  it("projects terminal canonical core effects without claiming browser delivery", () => {
    const event = mocks.append();
    const record: ProcessRelayRecord = {
      schemaVersion: 1 as const,
      generationId: "a".repeat(64),
      cursor: 1,
      deliveryId: `${"a".repeat(64)}:1`,
      kind: "canonical-event" as const,
      targets: ["canonical-core", "browser-render"],
      payload: event,
      previousMac: "b".repeat(64),
      mac: "c".repeat(64),
    };
    expect(projectProcessRelayTarget({} as never, record, "canonical-core")).toBe(true);
    expect(mocks.publish).toHaveBeenCalledWith("events:op-1", event);
    expect(mocks.bridge).toHaveBeenCalledWith(event, "non-browser");
    expect(mocks.cost).toHaveBeenCalledWith(event);
    vi.clearAllMocks();
    expect(projectProcessRelayTarget({} as never, record, "browser-render")).toBe(false);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
