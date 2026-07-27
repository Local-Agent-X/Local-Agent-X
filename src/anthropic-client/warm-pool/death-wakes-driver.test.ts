// A warm process that dies MID-TURN must terminate the turn.
//
// Regression (2026-07-26). `'claude' is not recognized as an internal or
// external command` → the spawned process exited code=1 eight milliseconds
// after acquire(), before emitting a single stdout frame. The read loop had
// already taken its `await new Promise(r => resolveNext = r)` branch, and the
// ONLY thing that ever called resolveNext was the stdout frame listener. The
// exit handler just set `state = "dead"` — a flag nobody was polling.
//
// The turn therefore never returned. Consequences, in order:
//   - the op sat in `turn_started` for 2.5 h until its lease expired
//   - the 600 s idle watchdog fired and called adapter.abort("idle-stalled"),
//     but THAT path also only set `state = "dead"` — equally stuck
//   - the background lane (cap 1) stayed occupied, so the 03:37 / 04:13 /
//     06:08 / 08:08 / 10:08 dreams queued and never dispatched
//   - the next boot's stale sweep failed all six, 0 tokens, turnIdx 0
//
// Every test here would HANG (not fail) before the fix — hence the explicit
// per-test timeouts: a regression shows up as a timeout, never as a pass.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { StreamEvent } from "../types.js";

const spawnMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

/** A child process that never speaks. `kill` is a no-op, like killing a corpse. */
function mutableProcess(): EventEmitter & Record<string, unknown> {
  const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  proc.pid = 4242;
  return proc;
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const KEY = { model: "claude-test", permissionMode: "plan" as const };

describe("warm process death wakes the in-flight driver", () => {
  let streamViaWarmPool: typeof import("./stream-prompt.js").streamViaWarmPool;
  let shutdownWarmPool: typeof import("./pool.js").shutdownWarmPool;

  beforeEach(async () => {
    spawnMock.mockReset();
    ({ streamViaWarmPool } = await import("./stream-prompt.js"));
    ({ shutdownWarmPool } = await import("./pool.js"));
    shutdownWarmPool();
  });

  afterEach(() => shutdownWarmPool());

  it("ends the turn with an error when the spawn dies before any frame", async () => {
    const proc = mutableProcess();
    spawnMock.mockReturnValueOnce(proc);

    const events = collect(streamViaWarmPool(KEY, { prompt: "hi" }));
    // Exactly the observed failure: exit lands a tick after the driver has
    // already parked on its await.
    await Promise.resolve();
    (proc.stderr as EventEmitter).emit("data", Buffer.from("'claude' is not recognized"));
    proc.emit("exit", 1);

    const got = await events;
    expect(got.at(-1)?.type).toBe("error");
    expect(String(got.at(-1)?.error)).toContain("claude' is not recognized");
  }, 5000);

  it("reports a spawn `error` (ENOENT) that never produces an exit event", async () => {
    const proc = mutableProcess();
    spawnMock.mockReturnValueOnce(proc);

    const events = collect(streamViaWarmPool(KEY, { prompt: "hi" }));
    await Promise.resolve();
    proc.emit("error", new Error("spawn claude ENOENT"));

    const got = await events;
    expect(got.at(-1)?.type).toBe("error");
    expect(String(got.at(-1)?.error)).toContain("ENOENT");
  }, 5000);

  it("drains frames the process emitted before dying, THEN errors", async () => {
    const proc = mutableProcess();
    spawnMock.mockReturnValueOnce(proc);

    const events = collect(streamViaWarmPool(KEY, { prompt: "hi" }));
    await Promise.resolve();
    (proc.stdout as EventEmitter).emit("data", Buffer.from(JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
    }) + "\n"));
    proc.emit("exit", 1);

    const got = await events;
    // Partial output must survive — death is not a reason to discard it.
    expect(got.some((e) => e.type === "text" && e.delta === "partial")).toBe(true);
    expect(got.at(-1)?.type).toBe("error");
  }, 5000);

  it("unblocks when the idle watchdog aborts a silent-but-live process", async () => {
    // The watchdog's escape hatch, which was itself wedged: abort with an
    // /idle|stalled|stop/ reason kills the process — and must wake the driver
    // even though a killed process may emit no further stdout.
    const proc = mutableProcess();
    spawnMock.mockReturnValueOnce(proc);
    const ac = new AbortController();

    const events = collect(streamViaWarmPool(KEY, { prompt: "hi", signal: ac.signal }));
    await Promise.resolve();
    ac.abort(new Error("idle-stalled"));

    const got = await events;
    expect(got.at(-1)?.type).toBe("error");
  }, 5000);

  it("still completes a healthy turn normally", async () => {
    const proc = mutableProcess();
    spawnMock.mockReturnValueOnce(proc);

    const events = collect(streamViaWarmPool(KEY, { prompt: "hi" }));
    await Promise.resolve();
    (proc.stdout as EventEmitter).emit("data", Buffer.from(JSON.stringify({
      type: "result", result: "all good", usage: { input_tokens: 5, output_tokens: 2 },
    }) + "\n"));

    const got = await events;
    expect(got.some((e) => e.type === "error")).toBe(false);
    expect(got.at(-1)?.type).toBe("done");
  }, 5000);
});
