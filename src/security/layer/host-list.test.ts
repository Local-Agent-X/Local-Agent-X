import { describe, expect, it } from "vitest";
import { matchEgressList } from "./host-list.js";
import { matchHost } from "../../tool-policy/matchers.js";

// One host matcher for the egress allowlist and tool-policy host rules. The
// tool-policy copy took the raw hostname, so `a.evil.com.` (trailing dot)
// slipped past a `*.evil.com` block, and an allow rule of `*.com` granted the
// whole TLD; the two lists also disagreed on whether `*.x.com` covers `x.com`.
describe("matchEgressList", () => {
	const list = new Set(["api.example.com", "*.evil.com", "*.com"]);

	it("matches exact hosts and wildcard subdomains, including the bare domain", () => {
		expect(matchEgressList("api.example.com", list)).toBe(true);
		expect(matchEgressList("a.evil.com", list)).toBe(true);
		expect(matchEgressList("evil.com", list)).toBe(true);
		expect(matchEgressList("notevil.com.example", list)).toBe(false);
	});

	it("decides on the canonical host: case, brackets and a trailing dot don't evade it", () => {
		expect(matchEgressList("A.EVIL.COM", list)).toBe(true);
		expect(matchEgressList("a.evil.com.", list)).toBe(true);
	});

	it("ignores a one-label wildcard unless the list refuses reach", () => {
		expect(matchEgressList("anything.com", new Set(["*.com"]))).toBe(false);
		expect(matchEgressList("anything.com", new Set(["*.com"]), { broadWildcards: true })).toBe(true);
	});
});

describe("tool-policy host rules use it", () => {
	it("a block on *.evil.com catches a trailing-dot host", () => {
		expect(matchHost(["*.evil.com"], "a.evil.com.", "block")).toBe(true);
	});

	it("a block honours a broad wildcard; an allow ignores one", () => {
		expect(matchHost(["*.ru"], "site.ru", "block")).toBe(true);
		expect(matchHost(["*.com"], "site.com", "allow")).toBe(false);
	});

	it("patterns are case-insensitive", () => {
		expect(matchHost(["API.Example.com"], "api.example.com", "allow")).toBe(true);
	});
});
