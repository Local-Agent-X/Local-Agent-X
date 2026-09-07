/**
 * F5 — the read_console / read_network / read_response refusal must name the
 * cause that actually applied.
 *
 * As landed, an emulating in-app session was told "not supported on the
 * external-Chrome backend — it is available in the in-app browser". The session
 * IS on the in-app route; the agent concluded the desktop bridge had dropped and
 * debugged that instead of clearing emulation.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { consoleCaptureRefusal, networkCaptureRefusal, responseCaptureRefusal } from "./cdp-capture-refusals.js";
import { EMULATION_PRESETS, setSessionEmulation, _resetSessionEmulationForTest } from "./emulation.js";
import { BrowserManager } from "./manager.js";

const OWNER = "chat-refusal";
const refusals = [
	["console", consoleCaptureRefusal],
	["network", networkCaptureRefusal],
	["response", responseCaptureRefusal],
] as const;

beforeEach(() => { _resetSessionEmulationForTest(); });
afterEach(() => { _resetSessionEmulationForTest(); });

describe("capture refusals name the cause that applied", () => {
	it.each(refusals)("%s: a genuine external-Chrome session is told about the backend", (_name, refusal) => {
		const text = refusal(OWNER);
		expect(text).toContain("external-Chrome backend");
		expect(text).not.toContain("emulating");
	});

	it.each(refusals)("%s: an EMULATING session is told about emulation and the way back", (_name, refusal) => {
		setSessionEmulation(OWNER, EMULATION_PRESETS.iphone);
		const text = refusal(OWNER);
		expect(text).toContain("while this session is emulating a device");
		expect(text).toContain("device='desktop'");
		// The false lead that cost the debugging time.
		expect(text).not.toContain("external-Chrome backend");
	});

	it("names the profile so the agent can see WHICH context it is on", () => {
		setSessionEmulation(OWNER, EMULATION_PRESETS.iphone);
		expect(consoleCaptureRefusal(OWNER)).toContain("390x844");
	});
});

describe("BrowserManager is wired to them", () => {
	// The strings above are only worth anything if the backend the emulated
	// session actually holds returns THEM — inlining the old text back into
	// manager.ts must go red here.
	const manager = new BrowserManager(OWNER, "in-app");

	it.each([
		["readConsole", () => manager.readConsole()],
		["readNetwork", () => manager.readNetwork()],
		["readResponse", () => manager.readResponse("https://example.com/")],
	] as const)("%s names emulation when the session is emulating", async (_name, call) => {
		setSessionEmulation(OWNER, EMULATION_PRESETS.iphone);
		const text = await call();
		expect(text).toContain("while this session is emulating a device");
		expect(text).not.toContain("external-Chrome backend");
	});

	it("still names the backend when the session is not emulating", async () => {
		await expect(manager.readConsole()).resolves.toContain("external-Chrome backend");
	});
});
