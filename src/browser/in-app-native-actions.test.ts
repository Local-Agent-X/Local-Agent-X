/**
 * Native ref-action fast-path contract (in-app-native-actions.ts): the in-app
 * backend prefers the frame-aware CDP path but must degrade to the bridge chain
 * on every miss. Regression for the reverted Job A ch4a — the fix's value is
 * that a miss/absence NEVER throws and ALWAYS signals fall-through (null).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const realDrivingPage = vi.fn();
const clickRefOn = vi.fn();
const fillRefOn = vi.fn();

vi.mock("./in-app-driving-page.js", () => ({ realDrivingPage: (...a: unknown[]) => realDrivingPage(...a) }));
vi.mock("./interactions.js", () => ({
	clickRefOn: (...a: unknown[]) => clickRefOn(...a),
	fillRefOn: (...a: unknown[]) => fillRefOn(...a),
}));

const { nativeClickRef, nativeFillRef } = await import("./in-app-native-actions.js");

const ctx = { viewId: "view-sess-p1", registry: {} as never, page: {} as never };
const fakePage = { __real: true } as never;

beforeEach(() => {
	realDrivingPage.mockReset();
	clickRefOn.mockReset();
	fillRefOn.mockReset();
});

describe("native ref-action fast-path", () => {
	it("returns null (fall through) when there is no CDP real Page", async () => {
		realDrivingPage.mockResolvedValue(null);
		expect(await nativeClickRef(ctx, 3)).toBeNull();
		expect(await nativeFillRef(ctx, 3, "x")).toBeNull();
		expect(clickRefOn).not.toHaveBeenCalled();
		expect(fillRefOn).not.toHaveBeenCalled();
	});

	it("returns the native result on success, targeting the real Page", async () => {
		realDrivingPage.mockResolvedValue(fakePage);
		clickRefOn.mockResolvedValue({ ok: true, text: "clicked native" });
		const res = await nativeClickRef(ctx, 7);
		expect(res).toEqual({ ok: true, text: "clicked native" });
		// It drove the REAL page through the shared frame-aware entry.
		expect(clickRefOn).toHaveBeenCalledWith(fakePage, ctx.registry, 7);
	});

	it("returns null (fall through) when the native attempt misses (ok:false)", async () => {
		realDrivingPage.mockResolvedValue(fakePage);
		clickRefOn.mockResolvedValue({ ok: false, text: "not found" });
		fillRefOn.mockResolvedValue({ ok: false, text: "not fillable" });
		// A SELECT/file/iframe-miss must degrade to the bridge chain, not surface
		// the native failure — so the caller's bridge fallback still runs.
		expect(await nativeClickRef(ctx, 7)).toBeNull();
		expect(await nativeFillRef(ctx, 7, "v")).toBeNull();
	});

	it("never throws — a native throw becomes a fall-through null", async () => {
		realDrivingPage.mockResolvedValue(fakePage);
		clickRefOn.mockRejectedValue(new Error("Timeout 3000ms exceeded\nlocator.click"));
		await expect(nativeClickRef(ctx, 7)).resolves.toBeNull();
	});

	it("native fill forwards the value to the shared entry", async () => {
		realDrivingPage.mockResolvedValue(fakePage);
		fillRefOn.mockResolvedValue({ ok: true, text: "filled" });
		const res = await nativeFillRef(ctx, 9, "hello");
		expect(res).toEqual({ ok: true, text: "filled" });
		expect(fillRefOn).toHaveBeenCalledWith(fakePage, ctx.registry, 9, "hello");
	});
});
