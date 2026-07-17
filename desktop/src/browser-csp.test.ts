import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

import { appendAgentCspHeaders, buildAgentCsp } from "./browser-csp";

/**
 * Anti-divergence: the desktop builder must byte-match the canonical
 * src/browser/csp-policy.ts:buildAgentCsp on every shared golden fixture. The
 * fixtures live in ONE place (src/browser/csp-fixtures.json) and are consumed by
 * BOTH this test and the root csp-policy test. We read the file at RUNTIME
 * (relative to this test, resolving up out of desktop/ into the repo's src/)
 * rather than via a static import — a static import would pull a file outside
 * desktop's tsconfig rootDir into the program. If either builder drifts in
 * directive order or token set, its project's fixture assertion fails.
 */
const FIXTURES_PATH = join(__dirname, "..", "..", "src", "browser", "csp-fixtures.json");
const { fixtures } = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as {
	fixtures: Array<{ url: string; note?: string; expectedCsp: string }>;
};

describe("browser-csp — lockstep with canonical src builder (shared golden fixtures)", () => {
	it("has fixtures to check", () => {
		expect(fixtures.length).toBeGreaterThan(0);
	});

	for (const { url, expectedCsp } of fixtures) {
		it(`matches the canonical CSP for ${JSON.stringify(url)}`, () => {
			expect(buildAgentCsp(url)).toBe(expectedCsp);
		});
	}
});

/**
 * Parse a CSP header value into a directive -> source-token[] map so we can
 * assert on which sources a directive allows rather than the serialized string.
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

const EXFIL_DIRECTIVES = [
	"connect-src", "img-src", "form-action", "frame-src", "child-src",
	"media-src", "font-src", "worker-src", "script-src", "style-src",
];

describe("browser-csp — private suffixes are tenant-scoped, never cross-tenant", () => {
	// tldts with allowPrivateDomains resolves these registry-operated suffixes to
	// the TENANT's registrable domain, so the wildcard covers only the tenant's
	// own subdomains — a bare *.herokuapp.com (which would reach every other
	// tenant) must NEVER be emitted.
	const cases: Array<{ url: string; tenant: string; suffix: string }> = [
		{ url: "https://app.myapp.herokuapp.com/x", tenant: "myapp.herokuapp.com", suffix: "herokuapp.com" },
		{ url: "https://foo.s3.amazonaws.com/bucket", tenant: "foo.s3.amazonaws.com", suffix: "s3.amazonaws.com" },
		{ url: "https://dash.tenant.vercel.app/x", tenant: "tenant.vercel.app", suffix: "vercel.app" },
	];

	for (const { url, tenant, suffix } of cases) {
		it(`${url} scopes the wildcard to ${tenant}, not *.${suffix}`, () => {
			const d = parse(buildAgentCsp(url));
			for (const name of EXFIL_DIRECTIVES) {
				const sources = d.get(name)!;
				// Tenant-scoped wildcard IS present.
				expect(sources).toContain(tenant);
				expect(sources).toContain(`*.${tenant}`);
				// The bare private-suffix host/wildcard must be absent — granting it
				// would reach every OTHER tenant on the same platform.
				expect(sources).not.toContain(suffix);
				expect(sources).not.toContain(`*.${suffix}`);
			}
		});
	}
});

describe("browser-csp — buildAgentCsp baseline", () => {
	it("denies by default and never throws on junk input", () => {
		for (const u of ["", "not a url", "about:blank", "data:text/html,x"]) {
			const d = parse(buildAgentCsp(u));
			expect(d.get("default-src")).toEqual(["'none'"]);
			expect(d.get("object-src")).toEqual(["'none'"]);
			expect(d.get("base-uri")).toEqual(["'none'"]);
			expect(d.get("frame-ancestors")).toEqual(["'none'"]);
			expect(d.get("connect-src")).toEqual(["'self'"]);
		}
	});
});

describe("appendAgentCspHeaders — onHeadersReceived injection", () => {
	const url = "https://app.example.com/page";

	it("APPENDS our CSP on a mainFrame response, preserving existing headers", () => {
		const original = {
			"content-type": ["text/html"],
			"X-Frame-Options": ["DENY"],
		};
		const out = appendAgentCspHeaders({ ...original, "content-type": [...original["content-type"]] }, "mainFrame", url);
		// Existing headers preserved untouched.
		expect(out["content-type"]).toEqual(["text/html"]);
		expect(out["X-Frame-Options"]).toEqual(["DENY"]);
		// Our CSP added, equal to the canonical builder output.
		expect(out["Content-Security-Policy"]).toEqual([buildAgentCsp(url)]);
	});

	it("APPENDS (does not replace) a CSP the site already sent — intersection enforced", () => {
		const siteCsp = "default-src 'self'";
		const out = appendAgentCspHeaders({ "content-security-policy": [siteCsp] }, "mainFrame", url);
		// The site's own CSP survives AND ours is added to the same array.
		expect(out["content-security-policy"]).toEqual([siteCsp, buildAgentCsp(url)]);
	});

	it("does NOT modify non-mainFrame responses (sub-resources inherit the doc CSP)", () => {
		for (const rt of ["subFrame", "stylesheet", "script", "image", "xhr", "other"]) {
			const original = { "content-type": ["application/javascript"] };
			const out = appendAgentCspHeaders(original, rt, url);
			expect(out["Content-Security-Policy"]).toBeUndefined();
			expect(out["content-security-policy"]).toBeUndefined();
			expect(out["content-type"]).toEqual(["application/javascript"]);
		}
	});

	it("handles a missing responseHeaders object (adds only our CSP)", () => {
		const out = appendAgentCspHeaders(undefined, "mainFrame", url);
		expect(out["Content-Security-Policy"]).toEqual([buildAgentCsp(url)]);
	});

	it("does not mutate the caller's responseHeaders object", () => {
		const original: Record<string, string[]> = { "content-type": ["text/html"] };
		appendAgentCspHeaders(original, "mainFrame", url);
		expect(original["Content-Security-Policy"]).toBeUndefined();
		expect(Object.keys(original)).toEqual(["content-type"]);
	});
});
