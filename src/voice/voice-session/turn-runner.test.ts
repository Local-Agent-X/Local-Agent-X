import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { createVoiceTurnMachine, firstChunkCut, type TurnSpeaker, type VoiceTurnMachineDeps } from "./turn-runner.js";
import type { VoiceTurnRunner } from "./types.js";

// Seam test for the canonical voice turn machine: drives a real turn through
// runTurn → speaker → the event stream, with fakes on both sides. Guards the
// behaviors the two engine factories now depend on (event order, history
// threading, dictate short-circuit, barge-in routing, drain → playback).

const logger = { info() {}, warn() {} };

function harness(opts: { mode?: "chat" | "dictate"; queued?: boolean; pendingCount?: () => number } = {}) {
  const events: Array<Record<string, unknown>> = [];
  const feeds: string[] = [];
  const ctx = {
    sessionId: "test-sess",
    mode: opts.mode ?? "chat",
    sendAudio: () => {},
    sendEvent: (e: Record<string, unknown>) => { events.push(e); },
  } as unknown as VoiceTurnMachineDeps["ctx"];
  const speaker: TurnSpeaker = {
    reset() {},
    feed(d) { feeds.push(d); },
    flushTail() {},
    hasQueued() { return !!opts.queued; },
    ...(opts.pendingCount ? { pendingCount: opts.pendingCount } : {}),
  };
  return { events, feeds, ctx, speaker, types: () => events.map((e) => e.type) };
}

const twoDeltaRun: VoiceTurnRunner = async ({ onDelta, history }) => {
  onDelta("Hello ");
  onDelta("world.");
  const updatedHistory: ChatCompletionMessageParam[] = [
    ...history,
    { role: "user", content: "hi" },
    { role: "assistant", content: "Hello world." },
  ];
  return { assistantText: "Hello world.", updatedHistory };
};

afterEach(() => { vi.useRealTimers(); });

describe("voice turn machine", () => {
  it("runs a turn: final → agent_start → deltas → done → terminal (no audio queued)", async () => {
    const h = harness({ queued: false });
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: twoDeltaRun, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    await machine.handleFinalTranscript("hi", 123);

    expect(h.types()).toEqual([
      "final", "agent_start", "assistant_delta", "assistant_delta",
      "assistant_done", "tts_idle", "playback_complete",
    ]);
    expect(h.feeds).toEqual(["Hello ", "world."]);
    expect(h.events[0]).toMatchObject({ type: "final", text: "hi", sttMs: 123 });
  });

  it("threads history across turns", async () => {
    const h = harness();
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: twoDeltaRun, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });
    const seen: number[] = [];
    const recordingRun: VoiceTurnRunner = async (input) => { seen.push(input.history.length); return twoDeltaRun(input); };
    const m2 = createVoiceTurnMachine({ ctx: h.ctx, runTurn: recordingRun, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    await m2.handleFinalTranscript("first");
    await m2.handleFinalTranscript("second");

    expect(seen[0]).toBe(0);     // first turn starts empty
    expect(seen[1]).toBe(2);     // second turn sees the first exchange
  });

  it("dictate mode emits only `final` — no agent turn", async () => {
    const h = harness({ mode: "dictate" });
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: twoDeltaRun, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    await machine.handleFinalTranscript("note this down");

    expect(h.types()).toEqual(["final"]);
  });

  it("barge-in routes to assistant_interrupted, never assistant_done", async () => {
    const h = harness();
    let cancelled = false;
    let release!: () => void;
    const parkedRun: VoiceTurnRunner = async ({ onDelta, signal, history }) => {
      onDelta("Partial ");
      await new Promise<void>((r) => { release = r; });
      const updatedHistory: ChatCompletionMessageParam[] = [...history, { role: "assistant", content: signal.aborted ? "[interrupted by user]" : "done" }];
      return { assistantText: "", updatedHistory };
    };
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: parkedRun, speaker: h.speaker, cancelTts: () => { cancelled = true; }, isClosed: () => false, logger });

    const p = machine.handleFinalTranscript("hello");
    await Promise.resolve();
    machine.interrupt();
    release();
    await p;

    expect(cancelled).toBe(true);
    expect(h.types()).toContain("tts_interrupt");
    expect(h.types()).toContain("assistant_interrupted");
    expect(h.types()).not.toContain("assistant_done");
  });

  it("firstChunkCut opens fast: clause break, else word boundary, else wait", () => {
    // Clause break ≥4 chars in → cut right after it ("Sure, ").
    expect("Sure, let me look".slice(0, firstChunkCut("Sure, let me look"))).toBe("Sure, ");
    // No early clause → first word boundary at/after the min length.
    expect(firstChunkCut("Let me take a look")).toBeGreaterThan(0);
    expect("Let me take a look".slice(0, firstChunkCut("Let me take a look")).trim().length).toBeGreaterThanOrEqual(12);
    // Too short / no boundary yet → wait (-1).
    expect(firstChunkCut("Hello")).toBe(-1);
    expect(firstChunkCut("supercalifragilistic")).toBe(-1); // long but no space yet
  });

  it("queued turn holds until drain, then schedules playback_complete", async () => {
    vi.useFakeTimers();
    const h = harness({ queued: true });
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: twoDeltaRun, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    await machine.handleFinalTranscript("hi");
    expect(h.types()).toContain("assistant_done");
    expect(h.types()).not.toContain("playback_complete"); // held for playback

    machine.noteAudioShipped(100);
    machine.markTtsDrained();      // engine signals queue empty
    vi.runAllTimers();             // playback-tail elapses

    expect(h.types()).toContain("playback_complete");
  });
});
