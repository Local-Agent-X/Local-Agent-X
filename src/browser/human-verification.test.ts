import { describe, expect, it } from "vitest";
import { requiresHumanVerification, snapshotShowsHumanVerification } from "./human-verification.js";

const observation = (overrides: Record<string, unknown> = {}) => ({
	title: "Example",
	currentRefs: [],
	crossOriginIframes: [],
	...overrides,
});

describe("human verification detection", () => {
	it("detects provider challenge frames", () => {
		expect(requiresHumanVerification(observation({
			crossOriginIframes: [{ src: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2" }],
		}) as never)).toBe(true);
		expect(requiresHumanVerification(observation({
			crossOriginIframes: [{ src: "https://www.google.com/recaptcha/api2/anchor" }],
		}) as never)).toBe(true);
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

	it("recognizes formatted snapshots returned by both browser backends", () => {
		expect(snapshotShowsHumanVerification(
			'Page: Just a moment... — https://dash.cloudflare.com/\n[4]<checkbox>Verify you are human</checkbox>',
		)).toBe(true);
		expect(snapshotShowsHumanVerification(
			'Page: CAPTCHA accessibility guide — https://example.com/\n[1]<link>CAPTCHA help</link>',
		)).toBe(false);
	});
});
