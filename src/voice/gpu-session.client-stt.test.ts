// A call whose phone transcribes on-device (clientStt): the desktop speaks but does not
// listen. Pins that the sidecar is asked for no STT, the phone's mic audio is ignored,
// its final text runs the turn, and its "user started talking" frame is the barge-in.
import { describe, expect, it, vi } from "vitest";
import type { GPUBridgeCallbacks } from "./gpu-bridge.js";
import type { VoiceSessionContext } from "./audio-ws.js";
import type { VoiceTurnRunner } from "./voice-session/index.js";

const bridges: Array<{ cb: GPUBridgeCallbacks; opts: { stt?: boolean }; fed: number; cancels: number }> = [];
vi.mock("./gpu-bridge.js", () => ({
  createGPUBridge: (cb: GPUBridgeCallbacks, _port: number | undefined, opts: { stt?: boolean } = {}) => {
    const record = { cb, opts, fed: 0, cancels: 0 };
    bridges.push(record);
    return {
      ready: () => new Promise(() => {}),
      feedAudio: () => { record.fed += 1; },
      flush: () => {},
      speak: () => {},
      cancelTTS: () => { record.cancels += 1; },
      reset: () => {},
      close: () => {},
      ttsSampleRate: 24000,
      micSampleRate: 16000,
    };
  },
}));
vi.mock("./voice-session/settings.js", () => ({ resolveVoiceSettings: () => ({}) }));

const { createGpuSession } = await import("./gpu-session.js");

function session(clientStt: boolean, runTurn: VoiceTurnRunner) {
  const events: Array<Record<string, unknown>> = [];
  const ctx = {
    sessionId: `gpu-${Math.random()}`, mode: "chat", clientStt,
    sendAudio: () => {}, sendEvent: (e: Record<string, unknown>) => events.push(e),
  } as unknown as VoiceSessionContext;
  const s = createGpuSession(ctx, runTurn);
  const bridge = bridges[bridges.length - 1]!;
  bridge.cb.onReady?.("test-gpu");
  return { s, bridge, events };
}

const reply: VoiceTurnRunner = async ({ history, onDelta }) => {
  onDelta("Sure.");
  return { assistantText: "Sure.", updatedHistory: history };
};

describe("gpu session, phone listening (clientStt)", () => {
  it("asks the sidecar for no STT and ignores the phone's mic audio", () => {
    const { s, bridge } = session(true, reply);
    expect(bridge.opts.stt).toBe(false);
    s.onMicFrame(new Int16Array(320));
    expect(bridge.fed).toBe(0);
    s.close();
  });

  it("runs the turn on the phone's final text", async () => {
    const runTurn = vi.fn(reply);
    const { s, events } = session(true, runTurn);
    s.onTranscript!("What's on my calendar?", true);
    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledOnce());
    expect(runTurn.mock.calls[0]![0].text).toBe("What's on my calendar?");
    expect(events.map((e) => e.type)).toContain("final");
    s.close();
  });

  it("treats a non-final frame as the barge-in: the reply in progress stops", async () => {
    let signal: AbortSignal | undefined;
    const hanging: VoiceTurnRunner = async (input) => {
      signal = input.signal;
      await new Promise<void>((res) => input.signal.addEventListener("abort", () => res()));
      return { assistantText: "", updatedHistory: input.history };
    };
    const { s, bridge, events } = session(true, hanging);
    s.onTranscript!("Tell me a long story", true);
    await vi.waitFor(() => expect(signal).toBeDefined());
    s.onTranscript!("", false);
    expect(signal!.aborted).toBe(true);
    expect(bridge.cancels).toBe(1);
    expect(events.map((e) => e.type)).toContain("tts_interrupt");
    s.close();
  });

  it("a desktop-listening call still loads STT and feeds the mic, and ignores transcript frames", () => {
    const runTurn = vi.fn(reply);
    const { s, bridge } = session(false, runTurn);
    expect(bridge.opts.stt).toBe(true);
    s.onMicFrame(new Int16Array(320));
    expect(bridge.fed).toBe(1);
    s.onTranscript!("injected", true);
    expect(runTurn).not.toHaveBeenCalled();
    s.close();
  });
});
