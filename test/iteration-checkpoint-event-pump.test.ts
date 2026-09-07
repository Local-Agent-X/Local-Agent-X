import { afterEach, describe, expect, it } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createEventPump } from "../src/canonical-loop/chat-runner/event-pump.js";
import { emit } from "../src/canonical-loop/event-emitter.js";
import { resetBus } from "../src/canonical-loop/index.js";

const OPS_BASE = join(homedir(), ".lax", "operations");
const tracked: string[] = [];
const track = <T extends string>(id: T): T => { tracked.push(id); return id; };

afterEach(() => {
  resetBus();
  for (const id of tracked) {
    const dir = join(OPS_BASE, id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  tracked.length = 0;
});

describe("chat event pump — iteration checkpoint UX", () => {
  it("surfaces a canonical iteration checkpoint without a chat error", async () => {
    const opId = track(`op_test_iteration_checkpoint_${Date.now()}`);
    const pump = createEventPump(opId);

    emit(opId, "iteration_checkpoint", {
      maxTurns: 25,
      completedTurns: 25,
      continuing: false,
    });

    const pulled = await pump.pull();
    pump.dispose();

    expect(pulled.events.some((event) => event.type === "error")).toBe(false);
    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("25-iteration checkpoint"),
    });
    expect(pulled.events).toContainEqual({
      type: "stopped",
      reason: "Checkpoint reached after 25 iterations. Say \"continue\" to keep going.",
      firedBy: "iteration-budget",
    });
  });

  // REGRESSION. Interactive ops now CONTINUE at the checkpoint instead of
  // dying at an arbitrary turn count. This branch used to `return` without
  // queueing anything, and the pump is the only thing that puts a message in
  // the chat stream — so a continuing checkpoint would have been completely
  // invisible to the very user this feature exists for: someone who walked
  // away and came back.
  it("still shows a progress line when the checkpoint is a continuing cadence", async () => {
    const opId = track(`op_test_iteration_continuing_${Date.now()}`);
    const pump = createEventPump(opId);

    emit(opId, "iteration_checkpoint", { maxTurns: 160, completedTurns: 160, continuing: true });

    const pulled = await pump.pull();
    pump.dispose();

    expect(pulled.events.some((event) => event.type === "error")).toBe(false);
    // NOT a `stopped` — the op is still running.
    expect(pulled.events.some((event) => event.type === "stopped")).toBe(false);
    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("Checkpoint saved after 160 turns"),
    });
    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("continuing automatically"),
    });
  });

  it("repeats the progress line at every continuing checkpoint, not just the first", async () => {
    const opId = track(`op_test_iteration_repeat_${Date.now()}`);
    const pump = createEventPump(opId);

    emit(opId, "iteration_checkpoint", { maxTurns: 160, completedTurns: 160, continuing: true });
    emit(opId, "iteration_checkpoint", { maxTurns: 160, completedTurns: 320, continuing: true });

    const pulled = await pump.pull();
    pump.dispose();

    const lines = pulled.events.filter((e) => e.type === "stream");
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).toContain("after 320 turns");
  });

  it("names the real reason when the checkpoint actually stops the op", async () => {
    const opId = track(`op_test_iteration_dry_${Date.now()}`);
    const pump = createEventPump(opId);

    emit(opId, "iteration_checkpoint", {
      maxTurns: 160,
      completedTurns: 480,
      continuing: false,
      stopReason: "dry-checkpoints",
      stopDetail: "two checkpoints in a row learned nothing new (7 distinct results seen)",
    });

    const pulled = await pump.pull();
    pump.dispose();

    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("turned up nothing new"),
    });
    expect(pulled.events).toContainEqual({
      type: "stopped",
      reason: "Stopped — no new information in the last stretch. Say \"continue\" to keep going.",
      debug: "two checkpoints in a row learned nothing new (7 distinct results seen)",
      firedBy: "iteration-budget",
    });
  });
});
