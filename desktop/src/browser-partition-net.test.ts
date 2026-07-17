/**
 * browser-partition-net — unit tests for the pure per-hop request helpers.
 * No Electron/config deps, so it runs under the standalone desktop vitest config.
 */
import { describe, expect, it } from "vitest";
import type { UploadData } from "electron";
import {
	AGENT_HARDENING_CSP,
	buildHardeningCspHeaders,
	extractUploadBody,
	cacheGet,
	cacheSet,
	clearDecisionCache,
} from "./browser-partition-net";

const bytes = (s: string): UploadData => ({ bytes: Buffer.from(s, "utf8") } as unknown as UploadData);

describe("buildHardeningCspHeaders", () => {
	it("adds our CSP when the response has none, preserving other headers", () => {
		const out = buildHardeningCspHeaders({ "content-type": ["text/html"] });
		expect(out["Content-Security-Policy"]).toEqual([AGENT_HARDENING_CSP]);
		expect(out["content-type"]).toEqual(["text/html"]);
	});

	it("APPENDS to a site's own CSP (never replaces) under any header casing", () => {
		const out = buildHardeningCspHeaders({ "content-security-policy": ["default-src 'self'"] });
		// Same array (both enforced → intersection); ours added, theirs kept.
		expect(out["content-security-policy"]).toEqual(["default-src 'self'", AGENT_HARDENING_CSP]);
		// Did not spawn a second differently-cased header.
		expect(Object.keys(out).filter((k) => k.toLowerCase() === "content-security-policy")).toHaveLength(1);
	});

	it("handles undefined responseHeaders", () => {
		expect(buildHardeningCspHeaders(undefined)["Content-Security-Policy"]).toEqual([AGENT_HARDENING_CSP]);
	});

	it("the hardening CSP is the exact 3-directive literal (mirror of csp-policy.ts)", () => {
		expect(AGENT_HARDENING_CSP).toBe("object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
	});
});

describe("extractUploadBody", () => {
	it("returns undefined for no upload / empty segments", () => {
		expect(extractUploadBody(undefined)).toBeUndefined();
		expect(extractUploadBody([])).toBeUndefined();
		expect(extractUploadBody([{ file: "/x" } as unknown as UploadData])).toBeUndefined();
	});

	it("decodes and concatenates in-memory byte segments", () => {
		expect(extractUploadBody([bytes("hello="), bytes("world")])).toBe("hello=world");
	});

	it("caps the decoded body at 128KB", () => {
		const out = extractUploadBody([bytes("A".repeat(200 * 1024))]);
		expect(out).toBeDefined();
		expect(out!.length).toBe(128 * 1024);
	});
});

describe("decision cache", () => {
	it("stores and returns a decision, and clears", () => {
		clearDecisionCache();
		expect(cacheGet("https://x/")).toBeNull();
		cacheSet("https://x/", true);
		expect(cacheGet("https://x/")).toBe(true);
		cacheSet("https://y/", false);
		expect(cacheGet("https://y/")).toBe(false);
		clearDecisionCache();
		expect(cacheGet("https://x/")).toBeNull();
	});
});
