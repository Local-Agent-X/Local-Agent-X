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
      agents: () => [{ id: "field-agent-1-x", name: "Recipe library", task: "Build the recipe library", sessionId: "s1", startedAt: Date.UTC(2026, 9, 26) }],
    });
    expect(parseWorkersSnapshot(JSON.parse(JSON.stringify(frame)))).toEqual({
      type: "workers_snapshot",
      workers: [
        { opId: "op_1", sessionId: "s1", task: "Build", status: "running", opType: "app_build", lastLine: "✓ turn 2 · write", totalTokens: 9000 },
        { opId: "op_ap_1", sessionId: "s1", task: "Improve", status: "paused" },
        { opId: "op_ap_2", sessionId: "autopilot", task: "Autopilot", status: "running" },
        // A named agent is listed by the id its card carries, so a client can end a card the snapshot leaves out.
        { opId: "field-agent-1-x", sessionId: "s1", task: "Build the recipe library", status: "running", opType: "agent_spawn", startedAt: "2026-10-26T00:00:00.000Z" },
      ],
    });
  });

  it("a worker's row says what it is changing and who else is in the same files, and the phone reads it", () => {
    const frame = buildWorkersSnapshot({
      canonical: () => [{ opId: "op_1", sessionId: "s1", task: "Build", status: "running" }, { opId: "op_2", sessionId: "s1", task: "Docs", status: "running" }],
      autopilot: () => [],
      agents: () => [{ id: "field-agent-1-x", name: "Fix STT", sessionId: "s1", startedAt: Date.UTC(2026, 9, 26) }],
      claims: () => [
        { sessionId: "chat-x", opId: "op_1", areas: ["src/app/"], clashesWith: [] },
        // A named agent's holder is its run session, `agent-<id>`.
        { sessionId: "agent-field-agent-1-x", opId: "op_inner", areas: ["src/voice/stt.ts"], clashesWith: ["Voice chat"] },
      ],
    });
    const parsed = parseWorkersSnapshot(JSON.parse(JSON.stringify(frame)))!;
    expect(parsed.workers.map((w) => [w.opId, w.areas, w.clashesWith])).toEqual([
      ["op_1", ["src/app/"], undefined],
      ["op_2", undefined, undefined],
      ["field-agent-1-x", ["src/voice/stt.ts"], ["Voice chat"]],
    ]);
  });
});
