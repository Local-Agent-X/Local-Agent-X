// The desktop's worker events and snapshot against the phone's half of the contract
// (vendor/workers.ts). Like chat-contract.test.ts, the event checks are compile-time:
// `npm run build` typechecks this file, so a bg_op_* change that an installed phone
// would drop or misread fails the build.

import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../types/server-events.js";
import type { WorkerEvent } from "./vendor/protocol.js";
import { parseWorkerFrames, parseWorkersSnapshot } from "./vendor/protocol.js";
import { buildWorkersSnapshot } from "../chat-ws/workers-snapshot.js";

type PhoneReads = WorkerEvent["type"];
type Emitted<T> = Extract<ServerEvent, { type: T }>;
/** true when the desktop emits `T` and every variant it emits fits the phone's shape. */
type Fits<T extends PhoneReads> = [Emitted<T>] extends [never]
  ? false
  : [Emitted<T>] extends [Extract<WorkerEvent, { type: T }>]
    ? true
    : false;

const fits: { [T in PhoneReads]: Fits<T> } = {
  bg_op_queued: true,
  bg_op_started: true,
  bg_op_progress: true,
  bg_op_completed: true,
};

describe("workers contract with the phone", () => {
  it("every worker event the phone reads is emitted in a shape it accepts", () => {
    expect(Object.values(fits).every(Boolean)).toBe(true);
  });

  it("a paused worker's progress event keeps its status on the phone", () => {
    const event: ServerEvent = { type: "bg_op_progress", opId: "op", line: "Operation paused", status: "paused", resumable: true };
    expect(parseWorkerFrames({ type: "event", sessionId: "s", event })).toEqual([
      { sessionId: "s", event: { type: "bg_op_progress", opId: "op", line: "Operation paused", status: "paused" } },
    ]);
  });

  it("the snapshot the desktop sends parses whole on the phone, autopilot runs included once", () => {
    const frame = buildWorkersSnapshot({
      canonical: () => [
        { opId: "op_1", sessionId: "s1", task: "Build", status: "running", opType: "app_build", lastLine: "✓ turn 2 · write", totalTokens: 9000 },
        { opId: "op_ap_1", sessionId: "s1", task: "Improve", status: "paused" },
      ],
      autopilot: () => [{ id: "op_ap_1", topic: "Improve" }, { id: "op_ap_2" }],
    });
    expect(parseWorkersSnapshot(JSON.parse(JSON.stringify(frame)))).toEqual({
      type: "workers_snapshot",
      workers: [
        { opId: "op_1", sessionId: "s1", task: "Build", status: "running", opType: "app_build", lastLine: "✓ turn 2 · write", totalTokens: 9000 },
        { opId: "op_ap_1", sessionId: "s1", task: "Improve", status: "paused" },
        { opId: "op_ap_2", sessionId: "autopilot", task: "Autopilot", status: "running" },
      ],
    });
  });
});
