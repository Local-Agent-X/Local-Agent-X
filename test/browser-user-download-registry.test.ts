// User-download registry (desktop/src/browser-user-download-registry.ts) —
// the Downloads panel's data source and the open/reveal safety boundary.
import { beforeEach, describe, expect, it } from "vitest";
import {
	_resetUserDownloadsForTest,
	listUserDownloads,
	recordUserDownload,
	updateUserDownload,
	userDownloadPath,
	type UserDownload,
} from "../desktop/src/browser-user-download-registry";

function entry(id: string, over: Partial<UserDownload> = {}): UserDownload {
	return {
		id, filename: `${id}.txt`, savePath: `/dl/${id}.txt`, url: `https://x/${id}`,
		bytes: 0, totalBytes: 100, state: "progressing", startedAt: 1000,
		...over,
	};
}

beforeEach(() => _resetUserDownloadsForTest());

describe("user-download registry", () => {
	it("lists newest first", () => {
		recordUserDownload(entry("a"));
		recordUserDownload(entry("b"));
		expect(listUserDownloads().map((e) => e.id)).toEqual(["b", "a"]);
	});

	it("updates progress and terminal state in place", () => {
		recordUserDownload(entry("a"));
		updateUserDownload("a", { bytes: 40 });
		expect(listUserDownloads()[0].bytes).toBe(40);
		updateUserDownload("a", { bytes: 100, state: "completed", doneAt: 2000 });
		expect(listUserDownloads()[0]).toMatchObject({ state: "completed", doneAt: 2000 });
		updateUserDownload("ghost", { bytes: 1 }); // unknown id is a no-op
	});

	it("caps at 200, evicting the oldest SETTLED entry — never one in flight", () => {
		recordUserDownload(entry("inflight-oldest")); // stays progressing
		for (let i = 0; i < 199; i++) recordUserDownload(entry(`d${i}`, { state: "completed" }));
		recordUserDownload(entry("newest", { state: "completed" }));
		const ids = listUserDownloads().map((e) => e.id);
		expect(ids).toHaveLength(200);
		expect(ids).toContain("inflight-oldest"); // skipped by eviction
		expect(ids).not.toContain("d0"); // oldest settled went instead
		expect(ids).toContain("newest");
	});

	it("resolves paths only for registry-known ids (quarantine can never be opened from here)", () => {
		recordUserDownload(entry("a"));
		expect(userDownloadPath("a")).toBe("/dl/a.txt");
		expect(userDownloadPath("some-quarantine-uuid")).toBeNull();
	});
});
