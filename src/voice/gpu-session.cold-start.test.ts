// A call that opens before the sidecar is ready: on a cold start it loads its speech
// model for the call (~3 s) while the phone already shows "Listening". Only the first 17
// frames were kept, so the call's first words were lost (2026-11-16). Pins that what the
// user says meanwhile reaches the sidecar in order, bounded, and still passes the
// near-field gate when the whole utterance was said before ready.
import { describe, expect, it, vi } from "vitest";
import type { GPUBridgeCallbacks } from "./gpu-bridge.js";
import type { VoiceSessionContext } from "./audio-ws.js";
import type { VoiceTurnRunner } from "./voice-session/index.js";

const bridges: Array<{ cb: GPUBridgeCallbacks; fed: Int16Array[] }> = [];
vi.mock("./gpu-bridge.js", () => ({
  createGPUBridge: (cb: GPUBridgeCallbacks) => {
    const record = { cb, fed: [] as Int16Array[] };
    bridges.push(record);
    return {
      ready: () => new Promise(() => {}),
      feedAudio: (f: Int16Array) => { record.fed.push(f); },
      flush: () => {},
      speak: () => {},
      cancelTTS: () => {},
      reset: () => {},
      setSttContext: () => {},
      close: () => {},
      ttsSampleRate: 24000,
      micSampleRate: 16000,
    };
  },
}));
vi.mock("./voice-session/settings.js", () => ({ resolveVoiceSettings: () => ({}) }));

const { createGpuSession } = await import("./gpu-session.js");

const FRAME = 320; // 20 ms at 16 kHz
const frame = (value: number) => new Int16Array(FRAME).fill(value);

function coldSession(runTurn: VoiceTurnRunner) {
  const ctx = {
    sessionId: `cold-${Math.random()}`, mode: "chat", clientStt: false,
    sendAudio: () => {}, sendEvent: () => {},
  } as unknown as VoiceSessionContext;
  const s = createGpuSession(ctx, runTurn);
  return { s, bridge: bridges[bridges.length - 1]! };
}

const reply: VoiceTurnRunner = async ({ history, onDelta }) => {
  onDelta("Sure.");
  return { assistantText: "Sure.", updatedHistory: history };
};

describe("gpu session, audio before the sidecar is ready", () => {
  it("feeds everything said while the model loaded, in order, at ready", () => {
    const { s, bridge } = coldSession(reply);
    // 3 s of speech before ready: 150 frames, each marked with its index.
    for (let i = 1; i <= 150; i++) s.onMicFrame(frame(i));
    expect(bridge.fed).toHaveLength(0);
    bridge.cb.onReady?.("test-gpu");
    expect(bridge.fed.map((f) => f[0])).toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    s.close();
  });

  it("keeps the newest 15 s when the load takes longer", () => {
    const { s, bridge } = coldSession(reply);
    const total = 50 * 20; // 20 s of frames
    for (let i = 1; i <= total; i++) s.onMicFrame(frame(i % 30000));
    bridge.cb.onReady?.("test-gpu");
    expect(bridge.fed).toHaveLength(50 * 15);
    expect(bridge.fed[bridge.fed.length - 1]![0]).toBe(total % 30000);
    s.close();
  });

  it("runs the turn for words said entirely before ready", async () => {
    const runTurn = vi.fn(reply);
    const { s, bridge } = coldSession(runTurn);
    for (let i = 0; i < 100; i++) s.onMicFrame(frame(8000)); // loud, near-field speech
    bridge.cb.onReady?.("test-gpu");
    // The sidecar hears the drained audio after the drain; only silence arrives live.
    bridge.cb.onSpeechStart?.();
    for (let i = 0; i < 25; i++) s.onMicFrame(frame(0));
    bridge.cb.onSpeechEnd?.();
    bridge.cb.onFinal?.("what time is it", 80);
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1));
    s.close();
  });
});
