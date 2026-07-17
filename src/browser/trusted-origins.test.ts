import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_TRUSTED_ORIGINS,
	addTrustedOrigin,
	isTrustedOrigin,
	trustedOrigins,
	_resetTrustedOrigins,
} from "./trusted-origins.js";

// The GENERAL origin-trust mechanism supervised mode consults. These tests pin
// the eTLD+1-aware matching contract: the default set is DATA, subdomains of a
// trusted registrable domain are trusted, and look-alikes are NOT.

describe("trusted-origins mechanism", () => {
	afterEach(() => _resetTrustedOrigins());

	it("ships the social/composer origins as data (not code branches)", () => {
		for (const d of ["x.com", "twitter.com", "instagram.com", "facebook.com", "tiktok.com", "linkedin.com"]) {
			expect(DEFAULT_TRUSTED_ORIGINS).toContain(d);
		}
	});

	it("trusts an exact registrable domain", () => {
		expect(isTrustedOrigin("https://x.com/")).toBe(true);
		expect(isTrustedOrigin("https://facebook.com/feed")).toBe(true);
	});

	it("trusts subdomains of a trusted registrable domain (eTLD+1-aware)", () => {
		expect(isTrustedOrigin("https://mobile.twitter.com/home")).toBe(true);
		expect(isTrustedOrigin("https://www.instagram.com/")).toBe(true);
		expect(isTrustedOrigin("https://business.facebook.com/x")).toBe(true);
	});

	it("REJECTS look-alikes — the suffix trick must fail", () => {
		expect(isTrustedOrigin("https://x.com.evil.com/")).toBe(false);
		expect(isTrustedOrigin("https://evil-x.com/")).toBe(false);
		expect(isTrustedOrigin("https://notx.com/")).toBe(false);
		expect(isTrustedOrigin("https://xacom/")).toBe(false);
	});

	it("rejects untrusted origins and unknowable URLs (fail safe)", () => {
		expect(isTrustedOrigin("https://example.com/")).toBe(false);
		expect(isTrustedOrigin("about:blank")).toBe(false);
		expect(isTrustedOrigin("")).toBe(false);
		expect(isTrustedOrigin("not a url")).toBe(false);
	});

	it("is case-insensitive on the host", () => {
		expect(isTrustedOrigin("https://WWW.X.COM/")).toBe(true);
	});

	it("grows through addTrustedOrigin without touching enforcement code", () => {
		expect(isTrustedOrigin("https://reddit.com/")).toBe(false);
		addTrustedOrigin("reddit.com");
		expect(trustedOrigins()).toContain("reddit.com");
		expect(isTrustedOrigin("https://old.reddit.com/")).toBe(true);
	});

	it("normalizes an added domain (scheme/path/www/dots stripped)", () => {
		addTrustedOrigin("https://www.threads.net/profile");
		expect(isTrustedOrigin("https://threads.net/")).toBe(true);
	});

	it("the default set is frozen — callers cannot mutate it", () => {
		expect(Object.isFrozen(DEFAULT_TRUSTED_ORIGINS)).toBe(true);
	});
});
