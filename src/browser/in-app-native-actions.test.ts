/**
 * Native ref-action fast-path contract (in-app-native-actions.ts). Guards two
 * regressions at once:
 *   - ch4a: iframe refs must resolve in the correct FRAME (resolveFrame), not
 *     the main document.
 *   - the ch4a-reuse hang: the native action MUST be bounded (3s), so a miss
 *     falls back to the bridge promptly instead of stalling ~30s.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const realDrivingPage = vi.fn();
const resolveFrame = vi.fn();
const clickSpy = vi.fn();
const fillSpy = vi.fn();

vi.mock("./in-app-driving-page.js", () => ({ realDrivingPage: (...a: unknown[]) => realDrivingPage(...a) }));
vi.mock("./actions.js", () => ({ resolveFrame: (...a: unknown[]) => resolveFrame(...a) }));
vi.mock("./stability.js", () => ({ waitForStability: vi.fn() }));
vi.mock("./observation.js", () => ({ ObservationRegistry: { format: () => "SNAPSHOT" } }));

const { nativeClickRef, nativeFillRef } = await import("./in-app-native-actions.js");

const fakePage = { __real: true } as never;
const iframeRef = { id: 42, role: "textbox", name: "Vendor", xpath: "/html/body/input[1]", frameUrl: "https://cloud.thrivemetrics.com/app/shopventory/" };

function makeCtx(ref: unknown) {
	return {
		viewId: "view-sess-p1",
		page: { url: () => "https://cloud.thrivemetrics.com/app/purchase-orders/external/create" } as never,
		registry: { recoverStaleRef: vi.fn().mockReturnValue(ref), observe: vi.fn().mockResolvedValue({}) } as never,
	};
}

beforeEach(() => {
	realDrivingPage.mockReset();
	resolveFrame.mockReset();
	clickSpy.mockReset();
	fillSpy.mockReset();
	resolveFrame.mockReturnValue({ locator: () => ({ click: clickSpy, fill: fillSpy }) });
});

describe("native ref-action fast-path", () => {
	it("returns null (fall through) when there is no CDP real Page", async () => {
		realDrivingPage.mockResolvedValue(null);
		expect(await nativeClickRef(makeCtx(iframeRef), 42)).toBeNull();
		expect(resolveFrame).not.toHaveBeenCalled();
	});

	it("returns null when the ref can't be recovered or has no xpath", async () => {
		realDrivingPage.mockResolvedValue(fakePage);
		expect(await nativeClickRef(makeCtx(undefined), 42)).toBeNull();
		expect(await nativeClickRef(makeCtx({ ...iframeRef, xpath: "" }), 42)).toBeNull();
		expect(clickSpy).not.toHaveBeenCalled();
	});

	it("resolves the ref's FRAME (not the main page) and clicks its xpath", async () => {
		realDrivingPage.mockResolvedValue(fakePage);
		clickSpy.mockResolvedValue(undefined);
		const res = await nativeClickRef(makeCtx(iframeRef), 42);
		// frame-aware: resolveFrame got the real page + the iframe ref
		expect(resolveFrame).toHaveBeenCalledWith(fakePage, iframeRef);
		expect(res?.ok).toBe(true);
		expect(res?.text).toContain("click (native)");
	});

	it("BOUNDS the native action to 3s so a miss can't hang (regression guard)", async () => {
		realDrivingPage.mockResolvedValue(fakePage);
		clickSpy.mockResolvedValue(undefined);
		fillSpy.mockResolvedValue(undefined);
		await nativeClickRef(makeCtx(iframeRef), 42);
		await nativeFillRef(makeCtx(iframeRef), 42, "Acme");
		expect(clickSpy).toHaveBeenCalledWith({ timeout: 3000 });
		expect(fillSpy).toHaveBeenCalledWith("Acme", { timeout: 3000 });
	});

	it("never throws — a native miss/timeout becomes a fall-through null", async () => {
		realDrivingPage.mockResolvedValue(fakePage);
		clickSpy.mockRejectedValue(new Error("Timeout 3000ms exceeded\nlocator.click"));
		await expect(nativeClickRef(makeCtx(iframeRef), 42)).resolves.toBeNull();
	});
});
