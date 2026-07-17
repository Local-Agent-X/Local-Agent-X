import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { buildAgentCsp } from "../src/browser/csp-policy.js";

/**
 * Bidirectional CSP lockstep — the SRC half.
 *
 * The shared golden fixtures (src/browser/csp-fixtures.json) are the one place
 * the exact CSP header string lives. The DESKTOP test (desktop/src/browser-csp.test.ts)
 * already asserts the desktop builder byte-matches every fixture. Until now the
 * SRC builder (src/browser/csp-policy.ts) was only checked against invariants,
 * never against these exact strings — so drift in the SRC serializer (directive
 * order, a token added/removed, a spacing change) would NOT fail CI even though
 * the desktop builder is pinned. This test closes that: SRC + desktop both
 * asserted byte-exact against the SAME fixtures = true bidirectional lockstep,
 * so the two backends' CSP can never silently diverge.
 *
 * If this fails, do NOT hand-edit expectedCsp — regenerate it from the canonical
 * builder and make both builders agree.
 */
const FIXTURES_PATH = fileURLToPath(
	new URL("../src/browser/csp-fixtures.json", import.meta.url),
);
const { fixtures } = JSON.parse(readFileSync(FIXTURES_PATH, "utf8")) as {
	fixtures: Array<{ url: string; note?: string; expectedCsp: string }>;
};

describe("csp-policy — SRC builder byte-locked to shared golden fixtures", () => {
	it("has fixtures to check", () => {
		expect(fixtures.length).toBeGreaterThan(0);
	});

	for (const { url, expectedCsp, note } of fixtures) {
		it(`byte-matches the fixture for ${JSON.stringify(url)}${note ? ` (${note})` : ""}`, () => {
			expect(buildAgentCsp(url)).toBe(expectedCsp);
		});
	}
});
