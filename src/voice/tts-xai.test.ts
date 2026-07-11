import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Contract: xAI voice rides the SuperGrok OAuth subscription ONLY. A metered
// API key (env or secrets store) must never pay for TTS — if resolveCredential
// hands back anything but an oauth-sourced credential, the engine skips
// without ever hitting the network.

const resolveCredential = vi.fn();
vi.mock("../auth/resolve.js", () => ({ resolveCredential: (...a: unknown[]) => resolveCredential(...a) }));

const fetchSpy = vi.fn();

beforeEach(() => {
	vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("xAI TTS credential gate", () => {
	it("skips (no network call) when the credential is an API key, not OAuth", async () => {
		resolveCredential.mockResolvedValue({ provider: "xai", credential: "xai-metered-key", source: "env" });
		const { synthesizeXai } = await import("./tts-xai.js");
		expect(await synthesizeXai("hello")).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("skips when a secrets-store key is the only credential", async () => {
		resolveCredential.mockResolvedValue({ provider: "xai", credential: "stored-key", source: "secrets-store" });
		const { synthesizeXai } = await import("./tts-xai.js");
		expect(await synthesizeXai("hello")).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("calls the TTS endpoint with the bearer when the credential is OAuth", async () => {
		resolveCredential.mockResolvedValue({ provider: "xai", credential: "oauth-token", source: "oauth" });
		fetchSpy.mockResolvedValue({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
		const { synthesizeXai } = await import("./tts-xai.js");
		const buf = await synthesizeXai("hello");
		expect(buf).toBeInstanceOf(Buffer);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe("https://api.x.ai/v1/tts");
		expect(init.headers.Authorization).toBe("Bearer oauth-token");
	});
});
