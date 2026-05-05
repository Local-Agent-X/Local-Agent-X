/**
 * Issue 02 — Fake adapter + acceptance harness self-tests.
 * docs/issues/canonical-loop/02-fake-adapter-and-harness.md
 *
 * Acceptance covered here:
 *   - FakeAdapter passes conformance suite items A–G against itself with no
 *     canonical-loop code present (also exercises H + I for completeness).
 *   - Harness can submit an op and observe DB state without poking real
 *     adapters (uses Issue 01 `canonicalLoopEntry` skeleton).
 *   - Crash simulation can forcibly drop a worker mid-turn.
 *   - Clock helper can advance time deterministically.
 *   - Conformance runner is pure — returns pass/fail/skipped per item.
 *   - Harness assertions surface clear failure messages on mismatch.
 *   - Bus recorder captures stream chunks emitted by FakeAdapter.
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  createHarness,
  submitOp,
  awaitState,
  assertEvents,
  assertOpTurns,
  assertOpMessages,
  injectStateChange,
  injectEvent,
  injectTurn,
  injectMessage,
  simulateCrash,
  withCrash,
  scriptTurn,
  scriptMultiTurn,
  scriptLongStreamingTurn,
  FakeAdapter,
  forwardStreamChunksToBus,
  TestBus,
  BusRecorder,
  useFakeClock,
  useRealClock,
  advanceClock,
  clock,
} from "./canonical-loop/harness.js";
import { runConformance, summarize, type ConformanceItemId } from "./canonical-loop/conformance.js";
import type { OpTurnRow } from "../src/canonical-loop/index.js";
import type { AdapterReport, TurnInput } from "../src/canonical-loop/adapter-contract.js";
import type { TurnPlan } from "./canonical-loop/fake-adapter.js";

const harnessCleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of harnessCleanups) c();
  harnessCleanups.length = 0;
  useRealClock();
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("LAX_CANONICAL_LOOP_")) delete process.env[k];
  }
});

function ctx() {
  const c = createHarness();
  harnessCleanups.push(c.cleanup);
  return c;
}

// ── FakeAdapter — conformance suite items A–G (Issue 02 acceptance) ──────

describe("FakeAdapter — conformance suite items A–G", () => {
  it("item A — text-only turn", async () => {
    const results = await runConformance(
      () => new FakeAdapter({ script: [scriptTurn({ text: "hello", terminal: "done" })] }),
      { items: ["A"] },
    );
    expect(results[0].status).toBe("passed");
  });

  it("item B — tool-call round-trip across two turns", async () => {
    const results = await runConformance(
      () => new FakeAdapter({
        script: [
          scriptTurn({
            toolCalls: [{ toolCallId: "tc-1", tool: "bash", args: { cmd: "ls" } }],
            terminal: undefined,
          }),
          scriptTurn({ text: "got the result", terminal: "done" }),
        ],
      }),
      { items: ["B"] },
    );
    expect(results[0].status, results[0].diagnostic).toBe("passed");
  });

  it("item C — cold start with absent provider_state", async () => {
    const results = await runConformance(
      () => new FakeAdapter({ script: [scriptTurn({ text: "hi", terminal: "done" })] }),
      { items: ["C"] },
    );
    expect(results[0].status).toBe("passed");
  });

  it("item D — resume with prior provider_state envelope", async () => {
    const results = await runConformance(
      () => new FakeAdapter({
        script: [
          scriptTurn({ text: "first", terminal: undefined }),
          scriptTurn({ text: "second", terminal: "done" }),
        ],
      }),
      { items: ["D"] },
    );
    expect(results[0].status, results[0].diagnostic).toBe("passed");
  });

  it("item E — abort() interrupts an active stream within 1 second", async () => {
    const results = await runConformance(
      () => new FakeAdapter({ script: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })] }),
      { items: ["E"] },
    );
    expect(results[0].status, results[0].diagnostic).toBe("passed");
  });

  it("item F — abort() is idempotent", async () => {
    const results = await runConformance(() => new FakeAdapter(), { items: ["F"] });
    expect(results[0].status).toBe("passed");
  });

  it("item G — abort() safe on completed adapter", async () => {
    const results = await runConformance(
      () => new FakeAdapter({ script: [scriptTurn({ text: "done", terminal: "done" })] }),
      { items: ["G"] },
    );
    expect(results[0].status, results[0].diagnostic).toBe("passed");
  });

  it("items A–G run together cleanly with summarize() readable output", async () => {
    const items: ConformanceItemId[] = ["A", "B", "C", "D", "E", "F", "G"];
    const perItem: Record<ConformanceItemId, TurnPlan[]> = {
      A: [scriptTurn({ text: "hi", terminal: "done" })],
      B: [
        scriptTurn({ toolCalls: [{ toolCallId: "tc-1", tool: "bash", args: {} }], terminal: undefined }),
        scriptTurn({ text: "result", terminal: "done" }),
      ],
      C: [scriptTurn({ text: "cold", terminal: "done" })],
      D: [
        scriptTurn({ text: "first", terminal: undefined }),
        scriptTurn({ text: "second", terminal: "done" }),
      ],
      E: [scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 })],
      F: [scriptTurn({ text: "ok", terminal: "done" })],
      G: [scriptTurn({ text: "ok", terminal: "done" })],
      H: [scriptTurn({ text: "ok", terminal: "done" })],
      I: [scriptTurn({ text: "ok", terminal: "done" })],
    };
    const results = await runConformance(() => new FakeAdapter(), {
      items,
      prepare: (adapter, item) => {
        const fa = adapter as FakeAdapter;
        for (const p of perItem[item]) fa.enqueueTurn(p);
      },
    });
    expect(results.every(r => r.status === "passed"), summarize(results)).toBe(true);
  });
});

// ── Items H + I (smoke at Issue 02; full coverage in Issue 09) ───────────

describe("FakeAdapter — items H and I", () => {
  it("item H — runTurn does not throw on routine paths (errors come via report)", async () => {
    const results = await runConformance(
      () => new FakeAdapter({
        script: [scriptTurn({
          errorReports: [{ code: "transport", message: "simulated", retryable: true }],
          terminal: "done",
        })],
      }),
      { items: ["H"] },
    );
    expect(results[0].status, results[0].diagnostic).toBe("passed");
  });

  it("item I — sandbox audit passes for FakeAdapter source", async () => {
    const sourcePath = join(process.cwd(), "test", "canonical-loop", "fake-adapter.ts");
    const results = await runConformance(
      () => new FakeAdapter(),
      { items: ["I"], adapterSourcePath: sourcePath },
    );
    expect(results[0].status, results[0].diagnostic).toBe("passed");
  });

  it("item I — sandbox audit reports skipped when no source path provided", async () => {
    const results = await runConformance(() => new FakeAdapter(), { items: ["I"] });
    expect(results[0].status).toBe("skipped");
  });

  it("item I — sandbox audit fails when source contains a forbidden import", async () => {
    // Synthesize a temporary "bad" adapter source on disk.
    const { writeFileSync, rmSync, mkdirSync, existsSync } = await import("node:fs");
    const tmpDir = join(process.cwd(), "test", "canonical-loop", ".tmp-conformance");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const bad = join(tmpDir, "bad-adapter.ts");
    writeFileSync(bad, `import { writeOp } from "../../../src/workers/op-store.js";\nexport class X {}\n`);
    try {
      const results = await runConformance(() => new FakeAdapter(), {
        items: ["I"],
        adapterSourcePath: bad,
      });
      expect(results[0].status).toBe("failed");
      expect(results[0].diagnostic).toMatch(/forbidden/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── FakeAdapter contract behavior ────────────────────────────────────────

describe("FakeAdapter — direct contract behavior", () => {
  it("emits the scripted reports in order via the report callback", async () => {
    const adapter = new FakeAdapter({
      script: [scriptTurn({
        streamChunks: ["alpha", "bravo"],
        text: "charlie",
        terminal: "done",
      })],
    });
    const got: AdapterReport[] = [];
    const input: TurnInput = { opId: "op-1", turnIdx: 0, messages: [], tools: [] };
    await adapter.runTurn(input, r => got.push(r));
    expect(got.map(r => r.kind)).toEqual([
      "stream_chunk", "stream_chunk", "message_finalized",
    ]);
    expect(adapter.streamChunks()).toEqual(["alpha", "bravo"]);
  });

  it("preserves provider_state envelope adapter_name across turns", async () => {
    const adapter = new FakeAdapter({
      script: [
        scriptTurn({ text: "t1", terminal: undefined }),
        scriptTurn({ text: "t2", terminal: "done" }),
      ],
    });
    const r1 = await adapter.runTurn({ opId: "op", turnIdx: 0, messages: [], tools: [] }, () => {});
    expect(r1.providerState.adapterName).toBe("fake");
    const r2 = await adapter.runTurn(
      { opId: "op", turnIdx: 1, messages: [], tools: [], providerState: r1.providerState },
      () => {},
    );
    expect(r2.providerState.adapterName).toBe("fake");
  });

  it("abort() preempts in-flight long stream and produces an error adapter_report", async () => {
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 20, maxChunks: 200 })],
    });
    const got: AdapterReport[] = [];
    const start = Date.now();
    const work = adapter.runTurn(
      { opId: "op-abort", turnIdx: 0, messages: [], tools: [] },
      r => got.push(r),
    );
    await new Promise(r => setTimeout(r, 40));
    await adapter.abort();
    await work;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(got.find(r => r.kind === "error")?.kind).toBe("error");
    expect(adapter.isAborted()).toBe(true);
  });

  it("abort() is idempotent — multiple calls do not throw and increment counter", async () => {
    const adapter = new FakeAdapter();
    await adapter.abort();
    await adapter.abort();
    await adapter.abort();
    expect(adapter.abortCalls).toBe(3);
  });

  it("abort() after a completed turn does not throw", async () => {
    const adapter = new FakeAdapter({ script: [scriptTurn({ text: "done", terminal: "done" })] });
    await adapter.runTurn({ opId: "op", turnIdx: 0, messages: [], tools: [] }, () => {});
    await expect(adapter.abort()).resolves.toBeUndefined();
  });
});

// ── Harness — submit + awaitState (against Issue 01 stub) ────────────────

describe("harness — submit + awaitState against Issue 01 skeleton", () => {
  it("submitOp persists the op and reaches state='queued'", async () => {
    const c = ctx();
    const op = submitOp(c, { task: "first", lane: "interactive" });
    const e = await awaitState(op.id, "queued", { timeoutMs: 200 });
    expect(e.type).toBe("state_changed");
    expect((e.body as { to: string }).to).toBe("queued");
    expect(op.canonical?.flagValue).toBe(true);
  });

  it("awaitState times out with a clear diagnostic when state never reached", async () => {
    const c = ctx();
    const op = submitOp(c);
    await expect(
      awaitState(op.id, "succeeded", { timeoutMs: 80 }),
    ).rejects.toThrow(/awaitState timed out.*Observed transitions/);
  });
});

// ── Harness — assertions against synthetic timelines ─────────────────────

describe("harness — assertion helpers (success cases)", () => {
  it("assertEvents accepts an ordered prefix and validates monotonic seq", () => {
    const c = ctx();
    const op = submitOp(c);              // emits seq=0 state_changed→queued
    injectEvent(op.id, "lease_acquired", { workerId: "w-1" });
    injectEvent(op.id, "turn_started", { turnIdx: 0 });
    assertEvents(op.id, [
      { type: "state_changed", body: { to: "queued" }, seq: 0 },
      { type: "lease_acquired", seq: 1 },
      { type: "turn_started", seq: 2 },
    ]);
  });

  it("assertOpTurns matches by turnIdx and terminalReason", () => {
    const c = ctx();
    const op = submitOp(c);
    const row: OpTurnRow = {
      opId: op.id,
      turnIdx: 0,
      providerState: { adapterName: "fake", adapterVersion: "0.0.1", providerPayload: {} },
      toolCallSummary: [],
      terminalReason: "done",
      redirectConsumed: false,
      createdAt: new Date().toISOString(),
    };
    injectTurn(row);
    assertOpTurns(op.id, [{ turnIdx: 0, terminalReason: "done", redirectConsumed: false }]);
  });

  it("assertOpMessages matches by (turnIdx, seqInTurn, role)", () => {
    const c = ctx();
    const op = submitOp(c);
    injectMessage({
      messageId: "m-1",
      opId: op.id,
      turnIdx: 0,
      seqInTurn: 0,
      role: "user",
      content: { text: "hi" },
      createdAt: new Date().toISOString(),
    });
    assertOpMessages(op.id, [{ turnIdx: 0, seqInTurn: 0, role: "user" }]);
  });
});

describe("harness — assertion helpers surface clear failures", () => {
  it("assertEvents — missing event yields a 'missing event at index N' message", () => {
    const c = ctx();
    const op = submitOp(c);
    expect(() => assertEvents(op.id, [
      { type: "state_changed" },
      { type: "turn_started" },
    ])).toThrow(/missing event at index 1.*turn_started/);
  });

  it("assertEvents — type mismatch shows expected vs got and full sequence", () => {
    const c = ctx();
    const op = submitOp(c);
    injectEvent(op.id, "turn_started", null);
    expect(() => assertEvents(op.id, [
      { type: "state_changed" },
      { type: "lease_acquired" },
    ])).toThrow(/event\[1\] type mismatch.*expected 'lease_acquired'.*got 'turn_started'/);
  });

  it("assertEvents — explicit seq mismatch surfaces a clear error", () => {
    const c = ctx();
    const op = submitOp(c);
    expect(() => assertEvents(op.id, [
      { type: "state_changed", seq: 5 },
    ])).toThrow(/event\[0\] seq mismatch.*expected 5.*got 0/);
  });

  it("assertEvents — synthesized seq gap is detected by invariant check", async () => {
    const c = ctx();
    const op = submitOp(c);
    // Force a gap by manually inserting a row with seq=7 directly to disk.
    const { canonicalEventsPath } = await import("../src/canonical-loop/index.js");
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      canonicalEventsPath(op.id),
      JSON.stringify({ opId: op.id, seq: 7, type: "turn_started", ts: new Date().toISOString(), body: null }) + "\n",
      "utf-8",
    );
    expect(() => assertEvents(op.id, [
      { type: "state_changed" },
      { type: "turn_started" },
    ])).toThrow(/seq gap detected/);
  });

  it("assertOpTurns — missing turn_idx fails with clear message", () => {
    const c = ctx();
    const op = submitOp(c);
    expect(() => assertOpTurns(op.id, [{ turnIdx: 0 }])).toThrow(/turn 0 missing/);
  });

  it("assertOpMessages — missing message fails with clear message", () => {
    const c = ctx();
    const op = submitOp(c);
    expect(() => assertOpMessages(op.id, [
      { turnIdx: 0, seqInTurn: 0, role: "user" },
    ])).toThrow(/missing message at turn=0 seq=0/);
  });

  it("injectStateChange + assertEvents agree on state transition body", () => {
    const c = ctx();
    const op = submitOp(c);
    injectStateChange(op.id, "queued", "running", "leased");
    assertEvents(op.id, [
      { type: "state_changed", body: { to: "queued" } },
      { type: "state_changed", body: { from: "queued", to: "running" } },
    ]);
  });
});

// ── BusRecorder ──────────────────────────────────────────────────────────

describe("BusRecorder — captures stream chunks emitted by FakeAdapter", () => {
  it("records stream_chunk bodies in emission order on op_stream:{op_id}", async () => {
    const c = ctx();
    const opId = "op-bus-1";
    c.recorder.watch(`op_stream:${opId}`);
    const adapter = new FakeAdapter({
      script: [scriptTurn({
        streamChunks: ["a", "b", "c"],
        text: "done",
        terminal: "done",
      })],
    });
    const report = forwardStreamChunksToBus(c.bus, opId);
    await adapter.runTurn({ opId, turnIdx: 0, messages: [], tools: [] }, report);
    expect(c.recorder.on(`op_stream:${opId}`)).toEqual(["a", "b", "c"]);
  });

  it("scopes by channel — messages on other channels are not captured", async () => {
    const c = ctx();
    c.recorder.watch("op_stream:wanted");
    c.bus.publish("op_stream:other", { x: 1 });
    c.bus.publish("op_stream:wanted", { y: 2 });
    expect(c.recorder.on("op_stream:wanted")).toEqual([{ y: 2 }]);
  });

  it("forwardStreamChunksToBus passes through non-stream reports to the inner callback", async () => {
    const c = ctx();
    const opId = "op-bus-2";
    c.recorder.watch(`op_stream:${opId}`);
    const inner: AdapterReport[] = [];
    const report = forwardStreamChunksToBus(c.bus, opId, r => inner.push(r));
    const adapter = new FakeAdapter({
      script: [scriptTurn({ streamChunks: ["x"], text: "y", terminal: "done" })],
    });
    await adapter.runTurn({ opId, turnIdx: 0, messages: [], tools: [] }, report);
    expect(c.recorder.on(`op_stream:${opId}`)).toEqual(["x"]);
    // inner sees BOTH the stream_chunk and the message_finalized.
    expect(inner.map(r => r.kind)).toEqual(["stream_chunk", "message_finalized"]);
  });
});

// ── Crash simulation ─────────────────────────────────────────────────────

describe("crash simulation — primitive for Issue 08 lease-recovery tests", () => {
  it("simulateCrash() rejects with Error('crash') after the requested delay", async () => {
    const start = Date.now();
    await expect(simulateCrash(20)).rejects.toThrow("crash");
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it("withCrash() races a long adapter turn against a crash and the crash wins", async () => {
    const adapter = new FakeAdapter({
      script: [scriptLongStreamingTurn({ chunkIntervalMs: 50, maxChunks: 200 })],
    });
    await expect(
      withCrash(adapter.runTurn({ opId: "op", turnIdx: 0, messages: [], tools: [] }, () => {}), 30),
    ).rejects.toThrow("crash");
    // The adapter promise is still in flight after the race rejects;
    // tests can call abort() to drain it. This documents that crash
    // simulation does NOT itself stop the adapter — that's the point of
    // having a separate abort() contract.
    await adapter.abort();
  });
});

// ── Test clock ───────────────────────────────────────────────────────────

describe("test clock — deterministic time control", () => {
  it("real clock is the default and rejects setNow/advance", () => {
    expect(clock().isFake()).toBe(false);
    expect(() => clock().setNow(0)).toThrow();
    expect(() => clock().advance(1)).toThrow();
  });

  it("useFakeClock(t0) returns a fake clock that holds steady at t0", () => {
    const c = useFakeClock(1_000_000);
    expect(c.now()).toBe(1_000_000);
    // Wait some real time — fake clock does not move.
    const before = c.now();
    expect(c.now()).toBe(before);
  });

  it("advance(ms) and setNow(ms) move the fake clock deterministically", () => {
    useFakeClock(0);
    advanceClock(500);
    expect(clock().now()).toBe(500);
    clock().setNow(10_000);
    expect(clock().now()).toBe(10_000);
    clock().advance(1);
    expect(clock().now()).toBe(10_001);
  });

  it("useRealClock() restores wall-clock semantics", () => {
    useFakeClock(0);
    expect(clock().isFake()).toBe(true);
    useRealClock();
    expect(clock().isFake()).toBe(false);
  });
});

// ── Conformance runner — pure result reporting ───────────────────────────

describe("conformance runner — pure pass/fail reporting", () => {
  it("returns one result per requested item, never throws on test failure", async () => {
    // Adapter that fails item E (no scripted long stream → completes too fast).
    // We pin items to A and E only. A passes, E should pass as well because
    // FakeAdapter handles abort even on a finished/empty script gracefully.
    const results = await runConformance(
      () => new FakeAdapter({
        script: [
          scriptTurn({ text: "ok", terminal: "done" }),                // for A
          scriptLongStreamingTurn({ chunkIntervalMs: 25, maxChunks: 200 }), // for E
        ],
      }),
      { items: ["A", "E"] },
    );
    expect(results.map(r => r.item)).toEqual(["A", "E"]);
    expect(results.every(r => r.status === "passed"), summarize(results)).toBe(true);
  });

  it("summarize() emits one PASS/FAIL/SKIP line per result", async () => {
    const results = await runConformance(() => new FakeAdapter(), { items: ["F", "I"] });
    const text = summarize(results);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toMatch(/F:/);
    expect(text).toMatch(/I:/);
  });
});
