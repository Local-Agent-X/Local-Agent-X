import { describe, it, expect } from "vitest";
import { buildAgentCsp, registrableDomain } from "./csp-policy.js";

/**
 * Parse a CSP header value into a directive -> source-token[] map so tests can
 * assert on INVARIANTS (which sources a directive allows) rather than on the
 * exact serialized string.
 */
function parse(csp: string): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const part of csp.split(";")) {
		const tokens = part.trim().split(/\s+/).filter(Boolean);
		if (!tokens.length) continue;
		const [name, ...sources] = tokens;
		map.set(name, sources);
	}
	return map;
}

describe("registrableDomain", () => {
	it("collapses subdomains to eTLD+1", () => {
		expect(registrableDomain("app.example.com")).toBe("example.com");
		expect(registrableDomain("a.b.c.example.com")).toBe("example.com");
		expect(registrableDomain("example.com")).toBe("example.com");
	});

	it("handles multi-part suffixes (foo.co.uk)", () => {
		expect(registrableDomain("foo.co.uk")).toBe("foo.co.uk");
		expect(registrableDomain("api.foo.co.uk")).toBe("foo.co.uk");
		expect(registrableDomain("shop.example.com.au")).toBe("example.com.au");
	});

	it("returns null for hosts with no registrable domain", () => {
		expect(registrableDomain("localhost")).toBeNull();
		expect(registrableDomain("app")).toBeNull();
		expect(registrableDomain("127.0.0.1")).toBeNull();
		expect(registrableDomain("::1")).toBeNull();
		expect(registrableDomain("")).toBeNull();
		// A bare public suffix has no +1 label.
		expect(registrableDomain("co.uk")).toBeNull();
	});

	it("handles public suffixes NOT in any hardcoded list (the fixed hole)", () => {
		// These second-level public suffixes (com.pl, com.ua, org.pl, co.th) were
		// absent from the old exact-match set and collapsed to a 2-label
		// public-suffix registrable. They must now resolve to the 3-label eTLD+1.
		expect(registrableDomain("shop.example.com.pl")).toBe("example.com.pl");
		expect(registrableDomain("example.com.pl")).toBe("example.com.pl");
		expect(registrableDomain("foo.com.ua")).toBe("foo.com.ua");
		expect(registrableDomain("bar.org.pl")).toBe("bar.org.pl");
		expect(registrableDomain("x.co.th")).toBe("x.co.th");
		// Bare public suffixes still have no registrant.
		expect(registrableDomain("com.pl")).toBeNull();
		expect(registrableDomain("org.pl")).toBeNull();
	});

	it("flat 2-label registrations under gTLDs and vanity ccTLDs use last-2", () => {
		expect(registrableDomain("example.io")).toBe("example.io");
		expect(registrableDomain("example.de")).toBe("example.de");
		expect(registrableDomain("example.com")).toBe("example.com");
	});

	it("resolves 2-char ccTLD hosts per the PSL (authoritative, not a heuristic)", () => {
		// .mz/.zw do NOT list weird./internal. as public suffixes in the PSL, so
		// these are ordinary registrant apexes — tldts wildcards them safely.
		expect(registrableDomain("foo.weird.mz")).toBe("weird.mz");
		expect(registrableDomain("data.internal.zw")).toBe("internal.zw");
		// .qq is not a delegated TLD; tldts still yields the last-2 registrable.
		expect(registrableDomain("a.b.qq")).toBe("b.qq");
	});

	it("scopes PSL PRIVATE-section (multi-tenant SaaS) suffixes to the TENANT", () => {
		// The confirmed hole: these gTLD-based private suffixes must NOT collapse
		// to the bare suffix. eTLD+1 is <tenant>.<suffix>, so the emitted wildcard
		// is tenant-scoped and cross-tenant hosts are out of scope.
		expect(registrableDomain("victim.herokuapp.com")).toBe("victim.herokuapp.com");
		expect(registrableDomain("bucket.s3.amazonaws.com")).toBe("bucket.s3.amazonaws.com");
		expect(registrableDomain("app.vercel.app")).toBe("app.vercel.app");
		expect(registrableDomain("site.pages.dev")).toBe("site.pages.dev");
		expect(registrableDomain("proj.web.app")).toBe("proj.web.app");
		expect(registrableDomain("blog.blogspot.com")).toBe("blog.blogspot.com");
		expect(registrableDomain("svc.azurewebsites.net")).toBe("svc.azurewebsites.net");
		expect(registrableDomain("app.netlify.app")).toBe("app.netlify.app");
		expect(registrableDomain("svc.onrender.com")).toBe("svc.onrender.com");
		expect(registrableDomain("edge.workers.dev")).toBe("edge.workers.dev");
		expect(registrableDomain("dist.cloudfront.net")).toBe("dist.cloudfront.net");
		expect(registrableDomain("proj.firebaseapp.com")).toBe("proj.firebaseapp.com");
		// A bare private suffix has no registrant/tenant -> null (fail-safe).
		expect(registrableDomain("herokuapp.com")).toBeNull();
		expect(registrableDomain("vercel.app")).toBeNull();
		expect(registrableDomain("pages.dev")).toBeNull();
	});
});

describe("buildAgentCsp — hardening-only (rendering-safe)", () => {
	// The policy is URL-independent now: the same-site fetch-scoping was reverted
	// (it broke every multi-CDN site). Only the zero-rendering-cost hardening
	// directives remain; cross-origin exfil is covered by page-egress-taint.ts.
	const d = parse(buildAgentCsp());

	it("emits exactly the three hardening directives", () => {
		expect([...d.keys()].sort()).toEqual(["base-uri", "frame-ancestors", "object-src"]);
	});

	it("object-src and frame-ancestors are 'none'; base-uri is 'self'", () => {
		expect(d.get("object-src")).toEqual(["'none'"]);
		expect(d.get("frame-ancestors")).toEqual(["'none'"]);
		// 'self' (not 'none') so a same-origin <base href="/"> keeps working while
		// an injected cross-origin <base> hijack is still blocked.
		expect(d.get("base-uri")).toEqual(["'self'"]);
	});

	it("sets NO default-src and NO fetch directives — subresources render freely", () => {
		// The whole point of the revert: nothing here may gate where a page loads
		// its own script/style/img/font/connect from, or multi-CDN sites break.
		for (const name of [
			"default-src", "connect-src", "script-src", "style-src",
			"img-src", "font-src", "media-src", "frame-src", "worker-src", "form-action",
		]) {
			expect(d.has(name)).toBe(false);
		}
	});

	it("carries no host tokens at all (purely 'none'/'self' hardening)", () => {
		const allSources = [...d.values()].flat();
		for (const s of allSources) {
			expect(s === "'none'" || s === "'self'").toBe(true);
		}
	});

	it("is a stable constant (no args, deterministic)", () => {
		expect(buildAgentCsp()).toBe(buildAgentCsp());
		expect(buildAgentCsp()).toBe("object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
	});
});
