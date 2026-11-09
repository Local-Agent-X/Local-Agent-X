import { describe, it, expect, vi, afterEach } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { createVoiceTurnMachine, type TurnSpeaker, type VoiceTurnMachineDeps } from "./turn-runner.js";
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
    device: "phone",
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

  it("tells the turn which device the call runs on", async () => {
    const h = harness();
    const devices: string[] = [];
    const recordingRun: VoiceTurnRunner = async (input) => { devices.push(input.device); return twoDeltaRun(input); };
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: recordingRun, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    await machine.handleFinalTranscript("can you see my camera");

    expect(devices).toEqual(["phone"]);
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

  it("latches an early TTS drain until the LLM finishes", async () => {
    vi.useFakeTimers();
    const h = harness({ queued: true });
    let machine: ReturnType<typeof createVoiceTurnMachine>;
    const fastTtsRun: VoiceTurnRunner = async ({ onDelta, history }) => {
      onDelta("Hi.");
      machine.markTtsDrained();
      return {
        assistantText: "Hi.",
        updatedHistory: [
          ...history,
          { role: "user", content: "hello" },
          { role: "assistant", content: "Hi." },
        ],
      };
    };
    machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: fastTtsRun, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    await machine.handleFinalTranscript("hello");
    expect(h.types()).toContain("tts_idle");
    vi.runAllTimers();
    expect(h.types()).toContain("playback_complete");

    await machine.handleFinalTranscript("again");
    expect(h.types().filter((type) => type === "agent_start")).toHaveLength(2);
  });
});

describe("voice turn machine — what the user showed", () => {
  it("sends an attachment with the next turn, and nothing with the one after", async () => {
    const h = harness();
    const seen: Array<string[] | undefined> = [];
    const runTurn: VoiceTurnRunner = async (input) => {
      seen.push(input.attachments?.map((a) => a.name));
      return twoDeltaRun(input);
    };
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });
    machine.attach([{ name: "a.jpg", type: "image/jpeg", isImage: true, dataUrl: "data:image/jpeg;base64,AAAA", size: 3 }]);
    await machine.handleFinalTranscript("what is this");
    await machine.handleFinalTranscript("thanks");
    expect(seen).toEqual([["a.jpg"], undefined]);
  });
});

describe("voice turn machine — noise gate", () => {
  it("drops a Whisper stage-direction final: no final, no turn, only the preview cleared", async () => {
    const h = harness();
    const runTurn = vi.fn(twoDeltaRun);
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    await machine.handleFinalTranscript("(muffled speaking");

    expect(h.events).toEqual([{ type: "partial", text: "" }]);
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("voice turn machine — continuation merge", () => {
  // A runTurn whose FIRST call hangs until barge-in aborts it (a reply cut
  // mid-stream) and records every input it receives.
  function makeHangingRun() {
    const inputs: Array<{ text: string; continuationOf?: string }> = [];
    const run: VoiceTurnRunner = async (input) => {
      inputs.push({ text: input.text, continuationOf: input.continuationOf });
      if (inputs.length === 1) {
        await new Promise<void>((res) => input.signal.addEventListener("abort", () => res()));
        return {
          assistantText: "partial reply",
          updatedHistory: [...input.history,
            { role: "user", content: input.text },
            { role: "assistant", content: "partial reply" }],
        };
      }
      return twoDeltaRun(input);
    };
    return { inputs, run };
  }

  it("merges the next final with a barged-over utterance the user barely heard", async () => {
    const h = harness();
    const { inputs, run } = makeHangingRun();
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: run, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    const p1 = machine.handleFinalTranscript("I was thinking about this");
    await Promise.resolve(); // let runTurn start (activeTurn set)
    machine.interrupt();     // barge-in before any audio shipped → heard 0ms
    await p1;

    await machine.handleFinalTranscript("and it keeps bothering me");

    expect(inputs[1].text).toBe("I was thinking about this and it keeps bothering me");
    expect(inputs[1].continuationOf).toBe("I was thinking about this");
  });

  // A runTurn whose first TWO calls hang until barge-in aborts them.
  function makeTwiceHangingRun() {
    const inputs: Array<{ text: string; continuationOf?: string }> = [];
    const run: VoiceTurnRunner = async (input) => {
      inputs.push({ text: input.text, continuationOf: input.continuationOf });
      if (inputs.length <= 2) {
        await new Promise<void>((res) => input.signal.addEventListener("abort", () => res()));
        return { assistantText: "", updatedHistory: input.history };
      }
      return twoDeltaRun(input);
    };
    return { inputs, run };
  }

  it("a barge-in that turns out to be noise resumes the reply it cut off", async () => {
    // 2026-11-05: the agent's own voice on speakerphone barged in on the next
    // turn, was dropped as far-field, and the user's words went unanswered.
    const h = harness();
    const { inputs, run } = makeHangingRun();
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: run, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    const p1 = machine.handleFinalTranscript("I'm about to get up.");
    await Promise.resolve();
    machine.interrupt();
    await p1;
    h.events.length = 0;

    machine.discardUtterance("far-field utterance");
    await vi.waitFor(() => expect(inputs).toHaveLength(2));

    // Same words, replacing the interrupted turn; no second `final` (the user's
    // line is already on screen), and the stale live preview is cleared.
    expect(inputs[1]).toEqual({ text: "I'm about to get up.", continuationOf: "I'm about to get up." });
    expect(h.types()[0]).toBe("partial");
    expect(h.events[0]).toMatchObject({ text: "" });
    expect(h.types()).not.toContain("final");
    expect(h.types()).toContain("agent_start");
  });

  it("a noise final resumes too, and a user still talking merges into the resumed turn", async () => {
    const h = harness();
    const { inputs, run } = makeTwiceHangingRun();
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: run, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    const p1 = machine.handleFinalTranscript("first half of the thought");
    await Promise.resolve();
    machine.interrupt();
    await p1;

    await machine.handleFinalTranscript("(muffled speaking"); // dropped by the noise gate
    await vi.waitFor(() => expect(inputs).toHaveLength(2));
    expect(inputs[1].text).toBe("first half of the thought");

    machine.interrupt(); // the user keeps talking over the resumed turn
    await machine.handleFinalTranscript("second half here");

    expect(inputs[2]).toEqual({ text: "first half of the thought second half here", continuationOf: "first half of the thought" });
  });

  it("a discarded utterance with nothing interrupted only clears the preview", async () => {
    const h = harness();
    const runTurn = vi.fn(twoDeltaRun);
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    machine.discardUtterance("far-field utterance");

    expect(h.events).toEqual([{ type: "partial", text: "" }]);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("does NOT merge when the user heard a real chunk of the reply first", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const h = harness();
    const { inputs, run } = makeHangingRun();
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: run, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    const p1 = machine.handleFinalTranscript("tell me a long story");
    await Promise.resolve();
    vi.advanceTimersByTime(900);         // TTFT + synthesis lead-in
    machine.noteAudioShipped(8000);      // reply started playing…
    vi.advanceTimersByTime(4000);        // …and the user listened for 4s
    machine.interrupt();                 // then cut in — that's a NEW intent
    await p1;
    vi.useRealTimers();

    await machine.handleFinalTranscript("actually never mind");

    expect(inputs[1].text).toBe("actually never mind");
    expect(inputs[1].continuationOf).toBeUndefined();
  });
});


describe("voice turn machine — a question the turn asked", () => {
  /** A turn that asks a question mid-run and returns what it heard. */
  function askingRun(heard: Array<string | null>, timeoutMs = 10_000): VoiceTurnRunner {
    return async ({ onDelta, awaitAnswer, history }) => {
      onDelta("Should I send it?");
      heard.push(await awaitAnswer!(timeoutMs, new AbortController().signal));
      return { assistantText: "Sent.", updatedHistory: [...history, { role: "assistant", content: "Sent." }] };
    };
  }

  it("the user's next words answer the question: no new turn, and the asking turn finishes", async () => {
    const h = harness();
    const heard: Array<string | null> = [];
    const runs: string[] = [];
    const runTurn: VoiceTurnRunner = async (input) => { runs.push(input.text); return askingRun(heard)(input); };
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    const turn = machine.handleFinalTranscript("email Bob the notes");
    await new Promise((r) => setTimeout(r, 0));
    await machine.handleFinalTranscript("yes go ahead");
    await turn;

    expect(heard).toEqual(["yes go ahead"]);
    expect(runs).toEqual(["email Bob the notes"]);
    expect(h.types()).toContain("assistant_done");
    expect(h.events.filter((e) => e.type === "final").map((e) => e.text)).toEqual(["email Bob the notes", "yes go ahead"]);
  });

  it("speaking the answer is not a barge-in", async () => {
    const h = harness();
    const heard: Array<string | null> = [];
    let cancelled = false;
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn: askingRun(heard), speaker: h.speaker, cancelTts: () => { cancelled = true; }, isClosed: () => false, logger });

    const turn = machine.handleFinalTranscript("email Bob the notes");
    await new Promise((r) => setTimeout(r, 0));
    machine.interrupt();
    await machine.handleFinalTranscript("yes");
    await turn;

    expect(cancelled).toBe(false);
    expect(h.types()).not.toContain("assistant_interrupted");
    expect(heard).toEqual(["yes"]);
  });

  it("no answer in the window resolves null, and the next words start a turn again", async () => {
    const h = harness();
    const heard: Array<string | null> = [];
    const runs: string[] = [];
    const runTurn: VoiceTurnRunner = async (input) => { runs.push(input.text); return input.text === "email Bob" ? askingRun(heard, 5)(input) : twoDeltaRun(input); };
    const machine = createVoiceTurnMachine({ ctx: h.ctx, runTurn, speaker: h.speaker, cancelTts: () => {}, isClosed: () => false, logger });

    await machine.handleFinalTranscript("email Bob");
    await machine.handleFinalTranscript("what's the weather");

    expect(heard).toEqual([null]);
    expect(runs).toEqual(["email Bob", "what's the weather"]);
  });
});
