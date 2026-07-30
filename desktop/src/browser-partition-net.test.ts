import { describe, expect, it } from "vitest";
import type { UploadData } from "electron";
import {
	cacheGet,
	cacheSet,
	clearDecisionCache,
	extractUploadBody,
} from "./browser-partition-net";

const bytes = (s: string): UploadData => ({ bytes: Buffer.from(s, "utf8") } as unknown as UploadData);

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
