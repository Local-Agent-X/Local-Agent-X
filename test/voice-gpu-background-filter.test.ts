// Background-voice filter on the Python-sidecar (GPU) voice session, the path
// phone voice uses. The sidecar's VAD fires on any speech, so in a noisy room
// nearby talkers cut off replies and became turns (2026-11-02, the owner in a
// noisy building). The session now confirms barge-in on near-field audio and
// drops a final whose utterance was far-field.
import { describe, it, expect, vi, beforeEach } from "vitest";

const captured = vi.hoisted(() => ({
	gpuCb: null as any,
	machine: null as any,
}));

vi.mock("../src/logger.js", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../src/voice/proactive-registry.js", () => ({
	registerVoiceSpeaker: vi.fn(),
	unregisterVoiceSpeaker: vi.fn(),
}));
vi.mock("../src/voice/voice-session/settings.js", () => ({ resolveVoiceSettings: () => ({ engine: "python" }) }));
vi.mock("../src/voice/voice-session/turn-runner.js", () => ({
	createVoiceTurnMachine: () => {
		captured.machine = {
			interrupt: vi.fn(),
			handleFinalTranscript: vi.fn().mockResolvedValue(undefined),
			speakProactive: vi.fn(),
			markTtsDrained: vi.fn(),
			noteAudioShipped: vi.fn(),
			close: vi.fn(),
		};
		return captured.machine;
	},
	SENTENCE_TERMINATOR: /[.!?]+\s/g,
	firstChunkCut: () => 0,
}));
vi.mock("../src/voice/gpu-bridge.js", () => ({
	createGPUBridge: vi.fn((cb: any) => {
		captured.gpuCb = cb;
		return {
			ttsSampleRate: 24000,
			ready: vi.fn(() => new Promise(() => {})),
			feedAudio: vi.fn(),
			flush: vi.fn(),
			speak: vi.fn(),
			cancelTTS: vi.fn(),
			close: vi.fn(),
		};
	}),
}));

const { createGpuSession } = await import("../src/voice/gpu-session.js");

/** 20ms 16kHz frames of a sine at a normalized amplitude. */
function frames(ms: number, amp: number): Int16Array[] {
	const out: Int16Array[] = [];
	for (let t = 0; t < ms; t += 20) {
		const f = new Int16Array(320);
		for (let i = 0; i < f.length; i++) f[i] = Math.round(amp * 32767 * Math.sin((t * 16 + i) * 0.06));
		out.push(f);
	}
	return out;
}

function start() {
	const ctx = { sessionId: "voice-1", mode: "chat" as const, clientStt: false, sendEvent: vi.fn(), sendAudio: vi.fn() };
	const session = createGpuSession(ctx as any, vi.fn());
	captured.gpuCb.onReady("test-gpu");
	return session;
}

/** One utterance: the sidecar's speech_start, the mic audio, speech_end, final. */
function speak(session: ReturnType<typeof start>, amp: number, text: string, ms = 600) {
	captured.gpuCb.onSpeechStart();
	for (const f of frames(ms, amp)) session.onMicFrame(f);
	captured.gpuCb.onSpeechEnd();
	captured.gpuCb.onFinal(text, 50);
}

beforeEach(() => {
	captured.gpuCb = null;
	captured.machine = null;
});

describe("gpu voice session background filter", () => {
	it("takes the user's utterance, then drops a far quieter one from the room", () => {
		const session = start();
		speak(session, 0.3, "what's on my calendar");
		speak(session, 0.03, "did you see the game last night");
		expect(captured.machine.handleFinalTranscript.mock.calls.map((c: any[]) => c[0])).toEqual(["what's on my calendar"]);
		session.close();
	});

	it("keeps the user's own softer phrase, which a desk-mic bar would drop", () => {
		// 2026-11-03: "Did you get that?" at ~24% of the user's level was dropped.
		const session = start();
		speak(session, 0.3, "what's on my calendar");
		speak(session, 0.075, "did you get that");
		expect(captured.machine.handleFinalTranscript.mock.calls.map((c: any[]) => c[0])).toEqual([
			"what's on my calendar",
			"did you get that",
		]);
		session.close();
	});

	it("interrupts a reply only once near-field audio confirms it is the user", () => {
		const session = start();
		speak(session, 0.3, "first question");
		captured.machine.interrupt.mockClear();

		captured.gpuCb.onSpeechStart();
		for (const f of frames(400, 0.03)) session.onMicFrame(f);
		expect(captured.machine.interrupt).not.toHaveBeenCalled();

		captured.gpuCb.onSpeechStart();
		for (const f of frames(200, 0.3)) session.onMicFrame(f);
		expect(captured.machine.interrupt).toHaveBeenCalledTimes(1);
		session.close();
	});
});
