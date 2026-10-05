import { describe, expect, it } from "vitest";
import { requiresHumanVerification, snapshotShowsHumanVerification } from "./human-verification.js";
import type { IframeInfo } from "./iframe-detector.js";

const observation = (overrides: Record<string, unknown> = {}) => ({
	title: "Example",
	currentRefs: [],
	crossOriginIframes: [],
	...overrides,
});

const frame = (src: string, over: Partial<IframeInfo> = {}): IframeInfo => ({
	src,
	origin: new URL(src).origin,
	rect: { x: 20, y: 400, width: 304, height: 78 },
	crossOrigin: true,
	answered: false,
	...over,
});

const onPage = (...frames: IframeInfo[]) => requiresHumanVerification(observation({ crossOriginIframes: frames }) as never);

describe("human verification detection", () => {
	it("detects provider challenge frames", () => {
		expect(onPage(frame("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2"))).toBe(true);
		expect(onPage(frame("https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=normal"))).toBe(true);
		expect(onPage(frame("https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&size=normal"))).toBe(true);
	});

	it("detects the Cloudflare interstitial without exposing a clickable ref", () => {
		expect(requiresHumanVerification(observation({
			title: "Just a moment...",
			currentRefs: [{ name: "Verify you are human" }],
		}) as never)).toBe(true);
	});

	it("does not flag ordinary pages that merely discuss CAPTCHA", () => {
		expect(requiresHumanVerification(observation({
			title: "How CAPTCHA works",
			currentRefs: [{ name: "Read about reCAPTCHA" }],
		}) as never)).toBe(false);
	});

	// A provider loading is not a challenge. Each of these sat on ordinary
	// sign-in and checkout pages and blocked every click, telling the model the
	// user had a CAPTCHA to solve that did not exist.
	it("does not flag an invisible-mode badge", () => {
		expect(onPage(frame("https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=invisible",
			{ rect: { x: 1100, y: 700, width: 256, height: 60 } }))).toBe(false);
	});

	it("does not flag a challenge frame parked off-screen until it is needed", () => {
		expect(onPage(frame("https://www.google.com/recaptcha/api2/bframe?hl=en&k=key",
			{ rect: { x: 0, y: -10000, width: 400, height: 580 } }))).toBe(false);
	});

	it("does not flag a widget the user has already completed", () => {
		expect(onPage(frame("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2", { answered: true }))).toBe(false);
	});

	it("still flags the challenge once it opens on screen, unanswered", () => {
		expect(onPage(frame("https://www.google.com/recaptcha/api2/bframe?hl=en&k=key",
			{ rect: { x: 300, y: 120, width: 400, height: 580 } }))).toBe(true);
	});

	it("recognizes formatted snapshots returned by both browser backends", () => {
		expect(snapshotShowsHumanVerification(
			'Page: Just a moment... — https://dash.cloudflare.com/\n[4]<checkbox>Verify you are human</checkbox>',
		)).toBe(true);
		expect(snapshotShowsHumanVerification(
			'Page: CAPTCHA accessibility guide — https://example.com/\n[1]<link>CAPTCHA help</link>',
		)).toBe(false);
	});

	it("does not read a provider out of page text", () => {
		expect(snapshotShowsHumanVerification(
			'Page: reCAPTCHA v3 setup — https://developers.google.com/recaptcha/docs/v3\n[2]<link>https://www.google.com/recaptcha/api.js</link>',
		)).toBe(false);
	});
});

describe("a shadow-hosted widget reported from its host", () => {
	it("is an open challenge until its response field is filled", () => {
		const widget = frame("https://challenges.cloudflare.com/turnstile/widget", { rect: { x: 40, y: 380, width: 300, height: 65 } });
		expect(onPage(widget)).toBe(true);
		expect(onPage({ ...widget, answered: true })).toBe(false);
	});
});
