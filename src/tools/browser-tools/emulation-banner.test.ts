/**
 * F3(b) — "the op ends emulated" has to have an answer.
 *
 * The profile is a process-lifetime Map and nothing in the chat/session
 * lifecycle clears it, so a 76-turn operation that ends while emulating leaves
 * the chat emulated and the user's next message drives the headless phone
 * context while their visible window does nothing. The route line is logger
 * output; the model never sees it. So the model is told at the moment of use,
 * on every browser action.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { emulationBanner } from "./emulation-banner.js";
import {
	EMULATION_PRESETS,
	setSessionEmulation,
	_resetSessionEmulationForTest,
} from "../../browser/emulation.js";

const SESSION = "chat-banner";

beforeEach(() => { _resetSessionEmulationForTest(); });
afterEach(() => { _resetSessionEmulationForTest(); });

describe("emulationBanner", () => {
	it("says nothing when the session is not emulating", () => {
		expect(emulationBanner(SESSION, "snapshot")).toBeNull();
	});

	it("tells the model it is not reading the user's window, and how to go back", () => {
		setSessionEmulation(SESSION, EMULATION_PRESETS.iphone);
		const banner = emulationBanner(SESSION, "snapshot");
		expect(banner).toContain("not the browser window the user is looking at");
		// No viewport numbers: it rides above layout_report's measured geometry.
		expect(banner).not.toMatch(/390x844|isMobile|hasTouch|User-Agent/);
		expect(banner).toContain("does not list the user's tabs");
		expect(banner).toContain('device:"desktop"');
	});

	it("fires on EVERY action, so a stale turn-start notice cannot be relied on", () => {
		setSessionEmulation(SESSION, EMULATION_PRESETS.android);
		for (const action of ["navigate", "screenshot", "layout_report", "tabs", "evaluate"]) {
			expect(emulationBanner(SESSION, action)).not.toBeNull();
		}
	});

	it("is silent for `emulate` itself — its own result already says all of it", () => {
		setSessionEmulation(SESSION, EMULATION_PRESETS.iphone);
		expect(emulationBanner(SESSION, "emulate")).toBeNull();
	});
});
