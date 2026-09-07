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
});
