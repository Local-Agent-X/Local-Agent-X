import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Prove the desktop registers the DNS-label-exfil hardening Chromium flags at
 * launch, and — critically — that the consolidated `--disable-features` switch
 * keeps BOTH features (Chromium honors only the LAST appendSwitch(
 * "disable-features", …), so a careless edit that adds a third disable
 * elsewhere, or drops one here, silently un-hardens the app).
 *
 * The flags now live in chromium-flags.ts (extracted from main.ts, a launch
 * orchestrator at the size ceiling). We keep a SOURCE-LEVEL assertion rather
 * than a module-load with a mocked electron: the flags module's import graph
 * still pulls in browser-partition and cdp-endpoint (electron-coupled), and a
 * source assertion catches the exact regression cared about (a feature
 * silently dropped from disable-features, or dns-prefetch-disable removed).
 */
const MAIN_TS = readFileSync(join(__dirname, "chromium-flags.ts"), "utf8");

describe("Chromium launch flags — DNS-label exfil hardening", () => {
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
