import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * C9 left this test for C8: prove main.ts registers the DNS-label-exfil
 * hardening Chromium flags at launch, and — critically — that the consolidated
 * `--disable-features` switch keeps BOTH features (Chromium honors only the
 * LAST appendSwitch("disable-features", …), so a careless edit that adds a
 * third disable elsewhere, or drops one here, silently un-hardens the app).
 *
 * WHY A SOURCE-LEVEL ASSERTION rather than a module-load with a mocked electron:
 * main.ts's Chromium flags are TOP-LEVEL side effects that run at import time,
 * and main.ts's import graph pulls in the entire Electron app wiring (config,
 * window, server-process, tray, ipc, native-speech, …), much of which needs a
 * live Electron main-process runtime — it cannot be import-evaluated under a
 * plain vitest/node worker without a large, brittle mock of every sibling
 * module. Extracting a testable helper would mean editing production security
 * code, which C8's scope forbids. The faithful, robust guard is therefore to
 * assert the exact appendSwitch calls exist in the source. This catches the
 * regression C9 cared about (a feature silently dropped from disable-features,
 * or dns-prefetch-disable removed) without refactoring the launch path.
 */
const MAIN_TS = readFileSync(join(__dirname, "main.ts"), "utf8");

describe("main.ts Chromium launch flags — DNS-label exfil hardening (C9)", () => {
	it("consolidates disable-features to EXACTLY AudioServiceSandbox + NetworkPrediction (nothing dropped)", () => {
		// The one and only disable-features appendSwitch must list both features.
		expect(MAIN_TS).toContain(
			'app.commandLine.appendSwitch("disable-features", "AudioServiceSandbox,NetworkPrediction")',
		);
		// There must be exactly ONE disable-features appendSwitch STATEMENT — a
		// second one would clobber this list (Chromium honors only the last),
		// silently dropping whichever feature isn't in the survivor. Match only
		// real statements (`app.commandLine.appendSwitch(...)`), not the prose
		// comment above the call that also names the switch.
		const disableFeatureCalls = MAIN_TS.match(
			/app\.commandLine\.appendSwitch\(\s*["']disable-features["']/g,
		);
		expect(disableFeatureCalls).toHaveLength(1);
	});

	it("adds the standalone dns-prefetch-disable switch", () => {
		expect(MAIN_TS).toContain('app.commandLine.appendSwitch("dns-prefetch-disable")');
	});

	it("keeps NetworkPrediction in the disable list (the DNS-label exfil closer)", () => {
		const m = MAIN_TS.match(/appendSwitch\(\s*["']disable-features["']\s*,\s*["']([^"']+)["']/);
		expect(m).not.toBeNull();
		const disabled = m![1].split(",").map((s) => s.trim());
		expect(disabled).toContain("NetworkPrediction");
		expect(disabled).toContain("AudioServiceSandbox");
	});
});
