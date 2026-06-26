// VoiceBridge tests — the voice control plane over the peer's `voice` data channel, with
// NO werift and NO broker socket. A fake ControlTransport stands in for the channel, a
// fake PeerAudioSink for the VoicePeer's audio, and a fake session factory captures the
// ctx so we can assert the audio router's TTS-rate snoop + barge-in flush.

import { describe, it, expect } from "vitest";
import { VoiceBridge } from "./voice-bridge.js";
import type { ControlTransport } from "../screen-stream/peer.js";
import type { VoiceSession, VoiceSessionContext } from "../voice/audio-ws.js";
import type { PeerAudioSink } from "../voice/voice-peer-session.js";

class FakeTransport implements ControlTransport {
  sent: string[] = [];
  private msg: ((t: string) => void) | null = null;
  private cls: (() => void) | null = null;
  send(text: string): void { this.sent.push(text); }
  onMessage(h: (t: string) => void): void { this.msg = h; }
  onClose(h: () => void): void { this.cls = h; }
  /** driver: the phone sent a control frame over the channel. */
  emit(obj: unknown): void { this.msg?.(JSON.stringify(obj)); }
  /** driver: the channel closed. */
  drop(): void { this.cls?.(); }
  get events(): Array<Record<string, unknown>> { return this.sent.map((s) => JSON.parse(s)); }
}

class FakePeer implements PeerAudioSink {
  tts: Array<{ frame: Int16Array; rate: number }> = [];
  interrupts = 0;
  writeTtsPcm(frame: Int16Array, sampleRate: number): void { this.tts.push({ frame, rate: sampleRate }); }
  interruptTts(): void { this.interrupts++; }
}

class FakeSession implements VoiceSession {
  mic: Int16Array[] = [];
  eos = 0;
  transcripts: Array<{ text: string; isFinal: boolean }> = [];
  settings: Array<{ voice?: string; speed?: number }> = [];
  closed = 0;
  onMicFrame(frame: Int16Array): void { this.mic.push(frame); }
  onEndOfSpeech(): void { this.eos++; }
  onTranscript(text: string, isFinal: boolean): void { this.transcripts.push({ text, isFinal }); }
  onVoiceSettings(s: { voice?: string; speed?: number }): void { this.settings.push(s); }
  close(): void { this.closed++; }
}

function makeBridge() {
  const peer = new FakePeer();
  const transport = new FakeTransport();
  let ctx: VoiceSessionContext | null = null;
  let session: FakeSession | null = null;
  const sessionFactory = (c: VoiceSessionContext): VoiceSession => {
    ctx = c;
    session = new FakeSession();
    return session;
  };
  const bridge = new VoiceBridge({ getPeer: () => peer, sessionFactory });
  bridge.attach(transport);
  return { bridge, peer, transport, getCtx: () => ctx, getSession: () => session };
}

describe("VoiceBridge — session lifecycle over the data channel", () => {
  it("opens a session on hello and replies ready", () => {
    const { transport, getCtx, getSession } = makeBridge();
    transport.emit({ type: "hello", sessionId: "s1", mode: "chat", clientStt: false });
    expect(getSession()).not.toBeNull();
    expect(getCtx()).toMatchObject({ sessionId: "s1", mode: "chat", clientStt: false });
    expect(transport.events).toContainEqual({ type: "ready", sessionId: "s1", mode: "chat" });
  });

  it("ignores a second hello (never double-opens a session)", () => {
    const { transport, getSession } = makeBridge();
    transport.emit({ type: "hello", sessionId: "s1" });
    const first = getSession();
    transport.emit({ type: "hello", sessionId: "s2" });
    expect(getSession()).toBe(first);
    expect(transport.events.filter((e) => e.type === "ready").length).toBe(1);
  });

  it("drops mic frames before hello (no session yet)", () => {
    const { bridge } = makeBridge();
    expect(() => bridge.onMicFrame(new Int16Array([1]))).not.toThrow();
  });
});

describe("VoiceBridge — audio router (shared with /ws/voice)", () => {
  it("snoops the TTS sample rate so outbound audio is paced at the engine rate", () => {
    const { transport, peer, getCtx } = makeBridge();
    transport.emit({ type: "hello", sessionId: "s1" });
    const ctx = getCtx()!;
    ctx.sendEvent({ type: "voice_ready", ttsSampleRate: 24000 });
    ctx.sendAudio(new Int16Array([1, 2, 3]));
    expect(peer.tts.at(-1)!.rate).toBe(24000);
    // the control event is STILL forwarded to the client over the channel
    expect(transport.events).toContainEqual({ type: "voice_ready", ttsSampleRate: 24000 });
  });

  it("flushes the RTP pacer on tts_interrupt (barge-in) and still forwards the event", () => {
    const { transport, peer, getCtx } = makeBridge();
    transport.emit({ type: "hello", sessionId: "s1" });
    getCtx()!.sendEvent({ type: "tts_interrupt" });
    expect(peer.interrupts).toBe(1);
    expect(transport.events).toContainEqual({ type: "tts_interrupt" });
  });
});

describe("VoiceBridge — inbound control → session", () => {
  it("routes mic frames + eos + transcript + voice_settings to the session", () => {
    const { bridge, transport, getSession } = makeBridge();
    transport.emit({ type: "hello", sessionId: "s1" });
    bridge.onMicFrame(new Int16Array([9]));
    transport.emit({ type: "eos" });
    transport.emit({ type: "transcript", text: "hello", isFinal: true });
    transport.emit({ type: "voice_settings", voice: "kokoro", speed: 1.2 });
    const s = getSession()!;
    expect(s.mic.length).toBe(1);
    expect(s.eos).toBe(1);
    expect(s.transcripts).toContainEqual({ text: "hello", isFinal: true });
    expect(s.settings).toContainEqual({ voice: "kokoro", speed: 1.2 });
  });

  it("ends the session on bye and on channel close", () => {
    const a = makeBridge();
    a.transport.emit({ type: "hello", sessionId: "s1" });
    a.transport.emit({ type: "bye" });
    expect(a.getSession()!.closed).toBe(1);

    const b = makeBridge();
    b.transport.emit({ type: "hello", sessionId: "s2" });
    b.transport.drop();
    expect(b.getSession()!.closed).toBe(1);
  });
});
