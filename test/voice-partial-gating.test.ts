// Regression: stray `partial` events after a committed voice turn.
//
// Zipformer decodes every mic frame — including TTS speaker echo and the
// trailing audio left after its endpoint reset — so after Whisper committed
// "Ready for another session." the server kept shipping noise partials like
// "SSION". The client renders any partial with no live preview bubble as a
// NEW dimmed user bubble, which then sat orphaned (blinking cursor) until
// the next vad_speech_start.
//
// Fix: partials are only forwarded while a VAD-confirmed utterance is in
// progress. Nothing legitimate is lost — the agent consumes Whisper's
// re-transcription of the buffered utterance, never the streaming previews.
// Covers both server paths: the in-process session (gates on the utterance
// buffer) and the Python-sidecar GPU session (gates on speech_start/end).
import { describe, it, expect, vi, beforeEach } from "vitest";

const captured = vi.hoisted(() => ({
	init: null as any,
	gpuCb: null as any,
}));

vi.mock("../src/logger.js", () => ({
	createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../src/local-only-policy.js", () => ({ isLocalOnlyMode: () => true }));
vi.mock("../src/voice/proactive-registry.js", () => ({
	registerVoiceSpeaker: vi.fn(),
	unregisterVoiceSpeaker: vi.fn(),
}));
vi.mock("../src/voice/voice-session/turn-runner.js", () => ({
	createVoiceTurnMachine: () => ({
		interrupt: vi.fn(),
		handleFinalTranscript: vi.fn().mockResolvedValue(undefined),
		speakProactive: vi.fn(),
		markTtsDrained: vi.fn(),
		noteAudioShipped: vi.fn(),
		close: vi.fn(),
	}),
	SENTENCE_TERMINATOR: /[.!?]+\s/g,
	firstChunkCut: () => 0,
}));
vi.mock("../src/voice/voice-session/settings.js", () => ({
	resolveVoiceSettings: () => ({
		engine: "tier4",
		sttProvider: "whisper",
		realtimeVoice: "",
		realtimeModel: "",
	}),
}));
vi.mock("../src/voice/voice-session/model-init.js", () => ({
	initializeVoiceStack: vi.fn(async (opts: any) => {
		captured.init = opts;
		return {
			stt: { feedAudio: vi.fn(), flush: vi.fn(), close: vi.fn() },
			tts: { speak: vi.fn(), cancel: vi.fn(), close: vi.fn() },
			vad: { feedAudio: vi.fn(), close: vi.fn() },
			whisper: { transcribe: vi.fn(async () => ""), close: vi.fn() },
			ttsSampleRate: 22050,
			ttsRuntime: null,
			sttRuntime: null,
		};
	}),
}));
vi.mock("../src/voice/realtime/index.js", () => ({
	createRealtimeSessionFromEnv: vi.fn(),
	realtimeReadiness: () => ({ ready: false, reason: "mocked" }),
}));
vi.mock("../src/voice/gpu-bridge.js", () => ({
	createGPUBridge: vi.fn((cb: any) => {
		captured.gpuCb = cb;
		return {
			ttsSampleRate: 24000,
			ready: vi.fn(() => Promise.resolve()),
			feedAudio: vi.fn(),
			flush: vi.fn(),
			speak: vi.fn(),
			cancelTTS: vi.fn(),
			close: vi.fn(),
		};
	}),
}));

const { createVoiceSessionFactory } = await import("../src/voice/voice-session/index.js");
const { createGpuSession } = await import("../src/voice/gpu-session.js");

function makeCtx() {
	return {
		sessionId: "test-session",
		mode: "chat" as const,
		clientStt: false,
		sendEvent: vi.fn(),
		sendAudio: vi.fn(),
	};
}

function partialsSent(ctx: ReturnType<typeof makeCtx>): string[] {
	return ctx.sendEvent.mock.calls
		.filter(([e]: any[]) => e.type === "partial")
		.map(([e]: any[]) => e.text);
}

beforeEach(() => {
	captured.init = null;
	captured.gpuCb = null;
});

describe("in-process voice session partial gating", () => {
	it("forwards partials only while the utterance buffer is active", async () => {
		const ctx = makeCtx();
		const session = createVoiceSessionFactory(vi.fn())(ctx as any);
		await new Promise((r) => setTimeout(r, 0));
		expect(captured.init).not.toBeNull();
		const { sttCallbacks, vadCallbacks } = captured.init;

		// Before any VAD speech-start: decoder noise, must be dropped.
		sttCallbacks.onPartial("SSION");
		expect(partialsSent(ctx)).toEqual([]);

		// Mid-utterance: the live preview is legitimate.
		vadCallbacks.onSpeechStart();
		sttCallbacks.onPartial("hey what's");
		expect(partialsSent(ctx)).toEqual(["hey what's"]);

		// After speech-end (utterance drained to Whisper): echo/trailing
		// fragments must be dropped again.
		vadCallbacks.onSpeechEnd();
		sttCallbacks.onPartial("SSION");
		expect(partialsSent(ctx)).toEqual(["hey what's"]);

		session.close?.();
	});
});

describe("gpu (sidecar) voice session partial gating", () => {
	it("forwards partials only between speech_start and speech_end", () => {
		const ctx = makeCtx();
		const session = createGpuSession(ctx as any, vi.fn());
		expect(captured.gpuCb).not.toBeNull();
		const cb = captured.gpuCb;

		cb.onPartial("SSION");
		expect(partialsSent(ctx)).toEqual([]);

		cb.onSpeechStart();
		cb.onPartial("hey what's");
		expect(partialsSent(ctx)).toEqual(["hey what's"]);

		cb.onSpeechEnd();
		cb.onPartial("SSION");
		expect(partialsSent(ctx)).toEqual(["hey what's"]);

		session.close?.();
	});
});
