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

  it("names the real reason when the checkpoint stops the op for lack of progress", async () => {
    const opId = track(`op_test_iteration_dry_${Date.now()}`);
    const pump = createEventPump(opId);

    emit(opId, "iteration_checkpoint", {
      maxTurns: 160,
      completedTurns: 480,
      continuing: false,
      stopReason: "dry-checkpoints",
      stopDetail: "two checkpoints in a row learned nothing new (7 distinct results over the whole op)",
    });

    const pulled = await pump.pull();
    pump.dispose();

    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("turned up nothing new"),
    });
    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("say \"continue\""),
    });
    expect(pulled.events).toContainEqual({
      type: "stopped",
      reason: "Stopped — no new information in the last stretch. Say \"continue\" to keep going.",
      debug: "two checkpoints in a row learned nothing new (7 distinct results over the whole op)",
      firedBy: "iteration-budget",
    });
    // Exactly one stop.
    expect(pulled.events.filter((e) => e.type === "stopped")).toHaveLength(1);
    expect(pulled.events.some((e) => e.type === "error")).toBe(false);
  });

  it("names the spend budget when the checkpoint stops the op for money", async () => {
    const opId = track(`op_test_iteration_spend_${Date.now()}`);
    const pump = createEventPump(opId);

    emit(opId, "iteration_checkpoint", {
      maxTurns: 160,
      completedTurns: 160,
      continuing: false,
      stopReason: "spend-ceiling",
      stopDetail: "this session's API spend ($15.20) reached the configured session budget ($15.00)",
    });

    const pulled = await pump.pull();
    pump.dispose();

    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("to stay inside your spend budget"),
    });
    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("session budget ($15.00)"),
    });
    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("say \"continue\""),
    });
    expect(pulled.events).toContainEqual({
      type: "stopped",
      reason: "Stopped — spend budget reached. Say \"continue\" to keep going.",
      debug: "this session's API spend ($15.20) reached the configured session budget ($15.00)",
      firedBy: "iteration-budget",
    });
    expect(pulled.events.filter((e) => e.type === "stopped")).toHaveLength(1);
  });

  it("a continuing checkpoint followed by a stop yields the progress line, then exactly one stop", async () => {
    const opId = track(`op_test_iteration_seq_${Date.now()}`);
    const pump = createEventPump(opId);

    emit(opId, "iteration_checkpoint", { maxTurns: 3, completedTurns: 3, continuing: true });
    emit(opId, "iteration_checkpoint", { maxTurns: 3, completedTurns: 6, continuing: true });
    emit(opId, "iteration_checkpoint", {
      maxTurns: 3, completedTurns: 9, continuing: false,
      stopReason: "dry-checkpoints", stopDetail: "two checkpoints in a row learned nothing new (1 distinct results over the whole op)",
    });

    const pulled = await pump.pull();
    pump.dispose();

    const stream = pulled.events.filter((e) => e.type === "stream");
    expect(stream).toHaveLength(3);
    expect(pulled.events.filter((e) => e.type === "stopped")).toHaveLength(1);
  });
});

describe("chat event pump — wall-clock deadline UX", () => {
  // With the turn wall gone, the 2h wall-clock is the backstop a user who
  // walked away actually hits. It must read like the checkpoint notice, not
  // a raw `deadline_exceeded: interactive operation exceeded maxWallTimeMs=…`
  // error bubble.
  it("renders the deadline as a human stop, with duration, saved work and how to continue", async () => {
    const opId = track(`op_test_deadline_${Date.now()}`);
    const pump = createEventPump(opId);

    // What the worker actually produces at the deadline: the adapter
    // acknowledges the abort first, THEN the worker names the cause.
    emit(opId, "error", { code: "aborted", message: "adapter aborted mid-stream", retryable: false });
    emit(opId, "error", {
      code: "deadline_exceeded",
      message: "interactive operation exceeded maxWallTimeMs=7200000",
      retryable: true,
      elapsedMs: 2 * 60 * 60 * 1000,
      maxWallTimeMs: 7_200_000,
    });

    const pulled = await pump.pull();
    pump.dispose();

    // No red error bubble (the adapter's abort acknowledgement included), and
    // the raw string never reaches a visible line
    // (it survives only in `debug`, the diagnostics field the UI hides).
    expect(pulled.events.some((e) => e.type === "error")).toBe(false);
    for (const e of pulled.events) {
      if (e.type === "stream" && "delta" in e) expect(e.delta).not.toContain("maxWallTimeMs");
      if (e.type === "stopped") expect(e.reason).not.toContain("maxWallTimeMs");
    }
    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("after 2 hours"),
    });
    expect(pulled.events).toContainEqual({
      type: "stream",
      delta: expect.stringContaining("The work so far is saved; say \"continue\""),
    });
    expect(pulled.events).toContainEqual({
      type: "stopped",
      reason: "Stopped after 2 hours — time limit for one request reached. Say \"continue\" to keep going.",
      debug: "deadline_exceeded: interactive operation exceeded maxWallTimeMs=7200000",
      firedBy: "wall-clock",
    });
    expect(pulled.events.filter((e) => e.type === "stopped")).toHaveLength(1);
  });

  it("still reads well when the worker supplied no elapsed time (relayed pre-upgrade event)", async () => {
    const opId = track(`op_test_deadline_bare_${Date.now()}`);
    const pump = createEventPump(opId);

    emit(opId, "error", { code: "deadline_exceeded", message: "interactive operation exceeded maxWallTimeMs=100", retryable: true });

    const pulled = await pump.pull();
    pump.dispose();

    expect(pulled.events.some((e) => e.type === "error")).toBe(false);
    expect(pulled.events).toContainEqual({
      type: "stopped",
      reason: "Stopped — time limit for one request reached. Say \"continue\" to keep going.",
      debug: "deadline_exceeded: interactive operation exceeded maxWallTimeMs=100",
      firedBy: "wall-clock",
    });
  });

  it("flushes a held abort acknowledgement, in order, when anything other than a deadline follows", async () => {
    const opId = track(`op_test_abort_flush_${Date.now()}`);
    const pump = createEventPump(opId);
    emit(opId, "error", { code: "aborted", message: "adapter aborted mid-stream", retryable: false });
    emit(opId, "error", { code: "worker_exception", message: "boom", retryable: false });
    const pulled = await pump.pull();
    pump.dispose();
    expect(pulled.events).toEqual([
      { type: "error", message: "aborted: adapter aborted mid-stream" },
      { type: "error", message: "worker_exception: boom" },
    ]);
  });

  it("flushes a held abort acknowledgement at terminal so a cancelled op still reports it", async () => {
    const opId = track(`op_test_abort_terminal_${Date.now()}`);
    const pump = createEventPump(opId);
    emit(opId, "error", { code: "aborted", message: "adapter aborted mid-stream", retryable: false });
    emit(opId, "state_changed", { from: "cancelling", to: "cancelled", reason: "adapter_aborted" });
    const pulled = await pump.pull();
    pump.dispose();
    expect(pulled.terminal).toBe("cancelled");
    expect(pulled.events).toEqual([{ type: "error", message: "aborted: adapter aborted mid-stream" }]);
  });

  it("leaves other error codes as chat errors", async () => {
    const opId = track(`op_test_other_error_${Date.now()}`);
    const pump = createEventPump(opId);
    emit(opId, "error", { code: "worker_exception", message: "boom", retryable: false });
    const pulled = await pump.pull();
    pump.dispose();
    expect(pulled.events).toEqual([{ type: "error", message: "worker_exception: boom" }]);
  });
});
