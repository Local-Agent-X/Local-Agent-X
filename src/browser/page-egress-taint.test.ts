/**
 * page-egress-taint — unit tests for the in-app browser's per-hop taint gate.
 *
 * The invariant under test is the whole reason the same-site CSP could be
 * reverted without reopening the exfil hole: a page's OWN network request is
 * blocked ONLY when it is cross-registrable-domain AND actually carries the
 * session's tainted / canary bytes. First-party hops and CDN/asset reads (which
 * carry neither) must pass, or multi-CDN rendering breaks — exactly what this
 * gate exists to avoid.
 */
import { afterEach, describe, expect, it } from "vitest";
import { scanPageEgress, isCrossSiteHop } from "./page-egress-taint.js";
import { recordSensitiveRead, clearSessionTaint } from "../data-lineage/index.js";
import { generateCanaries, registerSessionCanaries, clearSessionCanaries } from "../threat/canaries.js";

const SID = "sess-peg-test";
// >= SHINGLE_WIDTH (24) normalized chars so it actually fingerprints, and a
// distinctive value so an overlap match is unambiguous.
const SECRET = "aws_secret_access_key_9f8e7d6c5b4a3210ffeeddccbbaa";

afterEach(() => {
	clearSessionTaint(SID);
	clearSessionCanaries(SID);
});

describe("isCrossSiteHop", () => {
	it("same registrable domain (incl. subdomains) is first-party", () => {
		expect(isCrossSiteHop("https://api.example.com/x", "https://app.example.com/")).toBe(false);
		expect(isCrossSiteHop("https://example.com/x", "https://example.com/")).toBe(false);
	});

	it("different registrable domain is cross-site (the x.com ↔ twimg.com case)", () => {
		expect(isCrossSiteHop("https://abs.twimg.com/a.js", "https://x.com/")).toBe(true);
		expect(isCrossSiteHop("https://evil.com/collect", "https://x.com/")).toBe(true);
	});

	it("PSL private suffix stays tenant-scoped (cross-tenant is cross-site)", () => {
		expect(isCrossSiteHop("https://victim.herokuapp.com/x", "https://victim.herokuapp.com/")).toBe(false);
		expect(isCrossSiteHop("https://attacker.herokuapp.com/x", "https://victim.herokuapp.com/")).toBe(true);
	});

	it("unknown/opaque page origin is treated as cross-site (fail-safe scan)", () => {
		expect(isCrossSiteHop("https://evil.com/x", undefined)).toBe(true);
		expect(isCrossSiteHop("https://evil.com/x", "about:blank")).toBe(true);
	});

	it("an unparseable request URL is not a scannable hop (URL policy owns it)", () => {
		expect(isCrossSiteHop("not a url", "https://x.com/")).toBe(false);
	});
});

describe("scanPageEgress — taint overlap", () => {
	it("BLOCKS a cross-domain request whose URL carries tainted bytes", () => {
		recordSensitiveRead(SID, "secret", "vault:aws", SECRET);
		const v = scanPageEgress(SID, {
			url: `https://evil.com/collect?d=${SECRET}`,
			pageUrl: "https://myapp.com/",
		});
		expect(v.allowed).toBe(false);
		if (!v.allowed) expect(v.layer).toBe("data-lineage");
	});

	it("BLOCKS a cross-domain POST whose BODY carries tainted bytes", () => {
		recordSensitiveRead(SID, "secret", "vault:aws", SECRET);
		const v = scanPageEgress(SID, {
			url: "https://evil.com/collect",
			pageUrl: "https://myapp.com/",
			body: `{"stolen":"${SECRET}"}`,
		});
		expect(v.allowed).toBe(false);
	});

	it("ALLOWS the SAME tainted bytes to the page's OWN domain (first-party is not exfil)", () => {
		recordSensitiveRead(SID, "secret", "vault:aws", SECRET);
		const v = scanPageEgress(SID, {
			url: `https://api.myapp.com/save?d=${SECRET}`,
			pageUrl: "https://app.myapp.com/",
		});
		expect(v.allowed).toBe(true);
	});

	it("ALLOWS a cross-domain CDN asset read on a tainted session (rendering must survive)", () => {
		// The session is tainted, but the twimg.com asset URL carries none of the
		// tainted bytes — this is the case the reverted CSP got wrong.
		recordSensitiveRead(SID, "secret", "vault:aws", SECRET);
		const v = scanPageEgress(SID, {
			url: "https://abs.twimg.com/responsive-web/client-web/main.abc123.js",
			pageUrl: "https://x.com/home",
		});
		expect(v.allowed).toBe(true);
	});

	it("ALLOWS everything on a clean (untainted) session", () => {
		const v = scanPageEgress(SID, { url: "https://evil.com/collect?d=whatever", pageUrl: "https://x.com/" });
		expect(v.allowed).toBe(true);
	});
});

describe("scanPageEgress — canary tripwire", () => {
	it("BLOCKS a cross-domain request carrying a session canary and flags the audit", () => {
		const canaries = generateCanaries();
		registerSessionCanaries(SID, canaries);
		const v = scanPageEgress(SID, {
			url: `https://evil.com/x?c=${canaries[0]}`,
			pageUrl: "https://trusted.com/",
		});
		expect(v.allowed).toBe(false);
		if (!v.allowed) {
			expect(v.layer).toBe("canary");
			expect(v.canary).toBe(true);
		}
	});

	it("does NOT block a canary sent first-party (same-domain hop)", () => {
		const canaries = generateCanaries();
		registerSessionCanaries(SID, canaries);
		const v = scanPageEgress(SID, {
			url: `https://trusted.com/x?c=${canaries[0]}`,
			pageUrl: "https://trusted.com/",
		});
		expect(v.allowed).toBe(true);
	});
});
