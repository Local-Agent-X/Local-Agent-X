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

describe("buildAgentCsp — default deny", () => {
	it("(a) denies by default", () => {
		const d = parse(buildAgentCsp("https://app.example.com/page"));
		expect(d.get("default-src")).toEqual(["'none'"]);
		expect(d.get("object-src")).toEqual(["'none'"]);
		expect(d.get("frame-ancestors")).toEqual(["'none'"]);
		expect(d.get("base-uri")).toEqual(["'none'"]);
	});
});

describe("buildAgentCsp — same-site allowed", () => {
	const csp = buildAgentCsp("https://app.example.com/dashboard");
	const d = parse(csp);

	it("(b) allows same eTLD+1 (and subdomains) for connect/img/form", () => {
		for (const name of ["connect-src", "img-src", "form-action"]) {
			const sources = d.get(name)!;
			expect(sources).toContain("'self'");
			expect(sources).toContain("example.com");
			expect(sources).toContain("*.example.com");
		}
	});

	it("scopes to registrable domain, not the exact subdomain only", () => {
		// api.example.com is same-site with app.example.com -> must be allowed
		// via the *.example.com wildcard.
		expect(d.get("connect-src")).toContain("*.example.com");
	});
});

describe("buildAgentCsp — cross-origin denied (the exfil class)", () => {
	const d = parse(buildAgentCsp("https://app.example.com/x"));

	it("(c) does NOT allow an arbitrary attacker host in exfil directives", () => {
		const attacker = "evil.attacker-exfil.com";
		for (const name of ["connect-src", "img-src", "form-action", "frame-src", "media-src", "script-src"]) {
			const joined = d.get(name)!.join(" ");
			expect(joined).not.toContain(attacker);
			expect(joined).not.toContain("attacker");
			// No wildcard-everything and no scheme-wide network grant.
			expect(d.get(name)).not.toContain("*");
			expect(d.get(name)).not.toContain("https:");
			expect(d.get(name)).not.toContain("http:");
		}
	});

	it("connect-src carries no data:/blob: and no third-party host", () => {
		const sources = d.get("connect-src")!;
		expect(sources).not.toContain("data:");
		// Only 'self' + own-domain tokens.
		for (const s of sources) {
			expect(
				s === "'self'" || s === "example.com" || s === "*.example.com",
			).toBe(true);
		}
	});
});

describe("buildAgentCsp — documented concessions", () => {
	const d = parse(buildAgentCsp("https://app.example.com/x"));

	it("allows inline+eval script (execution) but still same-site egress only", () => {
		const script = d.get("script-src")!;
		expect(script).toContain("'unsafe-inline'");
		expect(script).toContain("'unsafe-eval'");
		// ...yet no cross-origin host: a running script has no remote sink.
		expect(script).toContain("'self'");
		expect(script).toContain("example.com");
		expect(script.join(" ")).not.toContain("attacker");
	});

	it("allows safe schemes on img/media/font only", () => {
		expect(d.get("img-src")).toContain("data:");
		expect(d.get("img-src")).toContain("blob:");
		expect(d.get("font-src")).toContain("data:");
		expect(d.get("worker-src")).toContain("blob:");
	});
});

describe("buildAgentCsp — edge cases never throw", () => {
	const cases = [
		"http://localhost:3000/app",
		"http://127.0.0.1:8080/",
		"https://[::1]:9000/",
		"about:blank",
		"data:text/html,<h1>hi</h1>",
		"not a url",
		"",
		"https://foo.co.uk/path",
	];

	for (const c of cases) {
		it(`handles ${JSON.stringify(c)} without throwing`, () => {
			let csp = "";
			expect(() => {
				csp = buildAgentCsp(c);
			}).not.toThrow();
			// Always at least a default-deny baseline.
			expect(csp).toContain("default-src 'none'");
			expect(parse(csp).get("connect-src")).toContain("'self'");
		});
	}

	it("multi-part suffix site scopes to eTLD+1 in the CSP", () => {
		const d = parse(buildAgentCsp("https://api.foo.co.uk/v1"));
		expect(d.get("connect-src")).toContain("foo.co.uk");
		expect(d.get("connect-src")).toContain("*.foo.co.uk");
	});

	it("localhost/IP pin to the exact host with any port, no wildcard subdomain", () => {
		const local = parse(buildAgentCsp("http://localhost:3000/app"));
		const conn = local.get("connect-src")!;
		expect(conn).toContain("localhost");
		expect(conn).toContain("localhost:*");
		expect(conn.some((s) => s.startsWith("*."))).toBe(false);

		const ip = parse(buildAgentCsp("http://127.0.0.1:8080/"));
		expect(ip.get("connect-src")).toContain("127.0.0.1");
		expect(ip.get("connect-src")).toContain("127.0.0.1:*");
	});

	it("opaque origins (about:blank) expose only 'self'", () => {
		const d = parse(buildAgentCsp("about:blank"));
		expect(d.get("connect-src")).toEqual(["'self'"]);
		expect(d.get("form-action")).toEqual(["'self'"]);
	});
});

// Every directive that can move bytes off the box. If a bare public-suffix
// wildcard ever appears in any of these, cross-registrant exfil is possible.
const EXFIL_DIRECTIVES = [
	"connect-src", "img-src", "form-action", "frame-src", "child-src",
	"media-src", "font-src", "worker-src", "script-src", "style-src",
];

describe("buildAgentCsp — public-suffix wildcard is never emitted (the fixed hole)", () => {
	// suffix -> a victim host under it, and the public-suffix wildcards that must
	// NOT appear anywhere in the exfil directives.
	const cases: Array<{ url: string; reg: string; forbidden: string[] }> = [
		{ url: "https://shop.example.com.pl/x", reg: "example.com.pl", forbidden: ["com.pl", "*.com.pl", "*.pl", "pl"] },
		{ url: "https://foo.com.ua/x", reg: "foo.com.ua", forbidden: ["com.ua", "*.com.ua", "*.ua"] },
		{ url: "https://bar.org.pl/x", reg: "bar.org.pl", forbidden: ["org.pl", "*.org.pl", "*.pl"] },
		{ url: "https://x.co.th/x", reg: "x.co.th", forbidden: ["co.th", "*.co.th", "*.th"] },
	];

	for (const { url, reg, forbidden } of cases) {
		it(`${url} scopes to ${reg} with no public-suffix wildcard`, () => {
			const d = parse(buildAgentCsp(url));
			for (const name of EXFIL_DIRECTIVES) {
				const sources = d.get(name)!;
				// The correct eTLD+1 wildcard IS present in same-site directives.
				expect(sources).toContain(`*.${reg}`);
				// None of the public-suffix wildcards/hosts may appear.
				for (const bad of forbidden) {
					expect(sources).not.toContain(bad);
					expect(sources).not.toContain(`*.${bad}`);
				}
			}
		});
	}

	it("evil.<suffix> is NOT reachable from a victim on the same public suffix", () => {
		// For each real public suffix: a victim registrant and a DIFFERENT
		// attacker registrant sharing the suffix. The victim's CSP must not grant
		// any source that matches the attacker host.
		const pairs: Array<{ victim: string; attacker: string }> = [
			{ victim: "https://app.example.com.pl/x", attacker: "evil.com.pl" },
			{ victim: "https://app.example.com.ua/x", attacker: "evil.com.ua" },
			{ victim: "https://app.example.org.pl/x", attacker: "evil.org.pl" },
			{ victim: "https://app.example.co.th/x", attacker: "evil.co.th" },
			{ victim: "https://app.example.co.uk/x", attacker: "evil.co.uk" },
			{ victim: "https://app.example.com/x", attacker: "evil.com" },
		];
		for (const { victim, attacker } of pairs) {
			const d = parse(buildAgentCsp(victim));
			const attackerReg = registrableDomain(attacker); // e.g. evil.com.pl or null
			for (const name of EXFIL_DIRECTIVES) {
				const sources = d.get(name)!;
				// The attacker host, its registrable, and every public-suffix
				// wildcard that would cover it must all be absent.
				expect(sources).not.toContain(attacker);
				if (attackerReg) {
					expect(sources).not.toContain(attackerReg);
					expect(sources).not.toContain(`*.${attackerReg}`);
				}
				// No wildcard in the list may match the attacker host.
				for (const s of sources) {
					if (s.startsWith("*.")) {
						const wildBase = s.slice(2); // e.g. example.com.pl
						expect(attacker.endsWith(`.${wildBase}`)).toBe(false);
					}
				}
			}
		}
	});

	it("2-char ccTLD host scopes to the PSL eTLD+1 (weird.mz is a registrant apex)", () => {
		const d = parse(buildAgentCsp("https://foo.weird.mz/x"));
		for (const name of EXFIL_DIRECTIVES) {
			const sources = d.get(name)!;
			// weird.mz IS the registrable domain per the PSL -> wildcard is safe.
			expect(sources).toContain("weird.mz");
			expect(sources).toContain("*.weird.mz");
			// The bare public suffix must never be wildcarded.
			expect(sources).not.toContain("mz");
			expect(sources).not.toContain("*.mz");
		}
	});
});

describe("buildAgentCsp — PSL private-suffix (multi-tenant SaaS) is tenant-scoped", () => {
	// Each private suffix + a victim tenant. The bare `*.<suffix>` wildcard would
	// be a CROSS-TENANT exfil grant; only the tenant-scoped `*.<tenant>.<suffix>`
	// may appear, and a DIFFERENT tenant must be unreachable.
	const cases: Array<{ url: string; tenant: string; suffix: string }> = [
		{ url: "https://victim.herokuapp.com/x", tenant: "victim.herokuapp.com", suffix: "herokuapp.com" },
		{ url: "https://bucket.s3.amazonaws.com/x", tenant: "bucket.s3.amazonaws.com", suffix: "amazonaws.com" },
		{ url: "https://app.vercel.app/x", tenant: "app.vercel.app", suffix: "vercel.app" },
		{ url: "https://site.pages.dev/x", tenant: "site.pages.dev", suffix: "pages.dev" },
		{ url: "https://proj.web.app/x", tenant: "proj.web.app", suffix: "web.app" },
		{ url: "https://blog.blogspot.com/x", tenant: "blog.blogspot.com", suffix: "blogspot.com" },
		{ url: "https://svc.azurewebsites.net/x", tenant: "svc.azurewebsites.net", suffix: "azurewebsites.net" },
		{ url: "https://app.netlify.app/x", tenant: "app.netlify.app", suffix: "netlify.app" },
		{ url: "https://svc.onrender.com/x", tenant: "svc.onrender.com", suffix: "onrender.com" },
		{ url: "https://edge.workers.dev/x", tenant: "edge.workers.dev", suffix: "workers.dev" },
		{ url: "https://dist.cloudfront.net/x", tenant: "dist.cloudfront.net", suffix: "cloudfront.net" },
	];

	for (const { url, tenant, suffix } of cases) {
		it(`${url} → *.${tenant}, never *.${suffix}`, () => {
			const attacker = `attacker.${suffix}`;
			const d = parse(buildAgentCsp(url));
			for (const name of EXFIL_DIRECTIVES) {
				const sources = d.get(name)!;
				// Tenant-scoped wildcard IS present (first-party subdomains work).
				expect(sources).toContain(`*.${tenant}`);
				expect(sources).toContain(tenant);
				// The bare private-suffix wildcard/host must NOT appear.
				expect(sources).not.toContain(suffix);
				expect(sources).not.toContain(`*.${suffix}`);
				// Reachability: a DIFFERENT tenant is not matched by any source.
				expect(sources).not.toContain(attacker);
				expect(sources).not.toContain(registrableDomain(attacker)!);
				for (const s of sources) {
					if (s.startsWith("*.")) {
						const wildBase = s.slice(2);
						// attacker.<suffix> must not be a subdomain of any wildcard,
						// and must not equal the wildcard base itself.
						expect(attacker === wildBase || attacker.endsWith(`.${wildBase}`)).toBe(false);
					}
				}
			}
		});
	}

	it("getDomain sanity: private suffix stays tenant-scoped, bare suffix is null", () => {
		// Guards against a future tldts option regression (e.g. dropping
		// allowPrivateDomains) silently reopening the cross-tenant hole.
		expect(registrableDomain("victim.herokuapp.com")).toBe("victim.herokuapp.com");
		expect(registrableDomain("attacker.herokuapp.com")).toBe("attacker.herokuapp.com");
		expect(registrableDomain("victim.herokuapp.com"))
			.not.toBe(registrableDomain("attacker.herokuapp.com"));
		expect(registrableDomain("herokuapp.com")).toBeNull();
	});
});
