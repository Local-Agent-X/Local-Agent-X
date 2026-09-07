/**
 * F6/M1 — the `route.kind === "in-app"` guard in applyEmulationRoute.
 *
 * Dropping it (override EVERY route while a profile is installed) survived the
 * suite as landed. It is not cosmetic: reason "emulation" is what makes
 * reportBrowserRoute log emulationRouteLine, whose sentence is "the user's
 * in-app view is untouched" — a claim about a view that does not exist on the
 * mode-not-in-app / headless / no-desktop-bridge arms.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { applyEmulationRoute, emulationRouteLine } from "./emulation-route.js";
import type { BrowserRoute } from "./route-resolve.js";
import { EMULATION_PRESETS, setSessionEmulation, _resetSessionEmulationForTest } from "./emulation.js";

const OWNER = "chat-guard";

beforeEach(() => { _resetSessionEmulationForTest(); });
afterEach(() => { _resetSessionEmulationForTest(); });

describe("applyEmulationRoute overrides ONLY the in-app arm", () => {
	it("sends an emulating in-app session to the private CDP context", () => {
		setSessionEmulation(OWNER, EMULATION_PRESETS.iphone);
		expect(applyEmulationRoute({ kind: "in-app", reason: "in-app" }, OWNER)).toEqual({
			kind: "cdp",
			reason: "emulation",
		});
	});

	it.each<BrowserRoute>([
		{ kind: "cdp", reason: "mode-not-in-app" },
		{ kind: "cdp", reason: "headless" },
		{ kind: "cdp", reason: "no-desktop-bridge" },
		{ kind: "cdp", reason: "windows-chat-chrome" },
	])("leaves the $reason arm's reason alone", (route) => {
		setSessionEmulation(OWNER, EMULATION_PRESETS.android);
		// Re-labelling these "emulation" would log a claim about an in-app view
		// the session does not have.
		expect(applyEmulationRoute(route, OWNER)).toEqual(route);
	});

	it("leaves an in-app session with NO profile alone", () => {
		const route: BrowserRoute = { kind: "in-app", reason: "in-app" };
		expect(applyEmulationRoute(route, OWNER)).toEqual(route);
	});

	it("the emulation route line is the sentence the guard makes true", () => {
		expect(emulationRouteLine("(sessionId=x)")).toContain("the user's in-app view is untouched");
	});
});
