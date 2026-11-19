import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTrustedDestination, isTrustedEmailRecipient } from "./http-egress-guard.js";

// The trusted-destination list is the egress allowlist, read through the one
// loader. Its own copy cached the parsed list by the file's text length, so
// replacing a trusted host with one of the same length left the old one trusted.
let dir: string;
const prev = process.env.LAX_DATA_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lax-trusted-dest-")); process.env.LAX_DATA_DIR = dir; });
afterEach(() => {
	if (prev === undefined) delete process.env.LAX_DATA_DIR; else process.env.LAX_DATA_DIR = prev;
	rmSync(dir, { recursive: true, force: true });
});

function allow(list: string[], mtime: number) {
	const path = join(dir, "egress-allowlist.json");
	writeFileSync(path, JSON.stringify(list));
	utimesSync(path, mtime, mtime);
}

describe("trusted destinations follow the egress allowlist file", () => {
	it("a host swapped for one of the same length stops being trusted", () => {
		allow(["a.com"], 1_700_000_000);
		expect(isTrustedDestination("https://a.com/x")).toBe(true);
		allow(["b.com"], 1_700_000_100);
		expect(isTrustedDestination("https://a.com/x")).toBe(false);
		expect(isTrustedDestination("https://b.com/x")).toBe(true);
	});

	it("matches wildcards and email domains with the same host semantics", () => {
		allow(["*.example.org", "ceo@corp.example"], 1_700_000_200);
		expect(isTrustedDestination("https://api.example.org/")).toBe(true);
		expect(isTrustedEmailRecipient("ceo@corp.example", new Set())).toBe(true);
		expect(isTrustedEmailRecipient("bob@mail.example.org", new Set())).toBe(true);
		expect(isTrustedEmailRecipient("bob@other.example", new Set())).toBe(false);
	});

	it("no allowlist file trusts nothing", () => {
		expect(isTrustedDestination("https://a.com/x")).toBe(false);
	});
});
