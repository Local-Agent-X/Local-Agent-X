/**
 * Proactive voice narration must reuse the turn lifecycle, never preempt a
 * live reply, and surface at the turn boundary. This guards the blast-radius
 * hazard: a proactive utterance racing a live turn would corrupt the shared
 * speaker buffer. The guarantee: if a turn is in flight, the proactive line
 * queues and only speaks once the turn settles.
 */
import { describe, expect, it } from "vitest";
import { createVoiceTurnMachine, type TurnSpeaker } from "../src/voice/voice-session/turn-runner.js";
import type { VoiceSessionContext } from "../src/voice/audio-ws.js";

const logger = { info() {}, warn() {} };

function harness() {
  const events: string[] = [];
  const fed: string[] = [];
  const speaker: TurnSpeaker = {
    reset() {},
    feed(d) { fed.push(d); },
    flushTail() {},
    hasQueued() { return false; }, // no audio queued → turns finalize synchronously
  };
  const ctx = {
    sessionId: "t",
    mode: "chat",
    sendEvent: (e: { type: string }) => events.push(e.type),
    sendAudio: () => {},
  } as unknown as VoiceSessionContext;
  return { events, fed, speaker, ctx };
}

describe("voice proactive speak", () => {
  it("speaks immediately when idle", () => {
    const { events, fed, speaker, ctx } = harness();
    const machine = createVoiceTurnMachine({
      ctx, speaker, logger,
      runTurn: async () => ({ assistantText: "", updatedHistory: [] }),
      cancelTts: () => {}, isClosed: () => false,
    });

    machine.speakProactive("the task finished");

    expect(fed).toContain("the task finished");
    expect(events).toContain("agent_start");
    expect(events).toContain("assistant_done");
  });

  it("queues behind a live turn and drains at the boundary (never cuts off)", async () => {
    const { events, fed, speaker, ctx } = harness();
    let resolveTurn!: () => void;
    const machine = createVoiceTurnMachine({
      ctx, speaker, logger,
      runTurn: () => new Promise((res) => { resolveTurn = () => res({ assistantText: "hi", updatedHistory: [] }); }),
      cancelTts: () => {}, isClosed: () => false,
    });

    // Start a real turn; it's now in flight (runTurn pending).
    const turnP = machine.handleFinalTranscript("hello");
    // A worker question arrives mid-turn → must NOT speak yet.
    machine.speakProactive("the worker needs input");

    expect(fed).not.toContain("the worker needs input");
    expect(events.filter((e) => e === "agent_start").length).toBe(1); // only the user turn

    // Turn completes → boundary reached → the queued line speaks now.
    resolveTurn();
    await turnP;

    expect(fed).toContain("the worker needs input");
    expect(events.filter((e) => e === "agent_start").length).toBe(2); // turn + proactive
  });

  it("is a no-op in dictate mode and for blank text", () => {
    const { events, fed, speaker } = harness();
    const ctx = { sessionId: "t", mode: "dictate", sendEvent: (e: { type: string }) => events.push(e.type), sendAudio: () => {} } as unknown as VoiceSessionContext;
    const machine = createVoiceTurnMachine({
      ctx, speaker, logger,
      runTurn: async () => ({ assistantText: "", updatedHistory: [] }),
      cancelTts: () => {}, isClosed: () => false,
    });

    machine.speakProactive("should not speak in dictate");
    machine.speakProactive("   ");

    expect(fed.length).toBe(0);
    expect(events).not.toContain("agent_start");
  });
});
