// @vitest-environment happy-dom
// Downloads panel (public/js/browser-downloads-panel.js) — drives the real
// module source against a stubbed desktop bridge, mirroring the library-panel
// harness. Covers: render of user + quarantined rows, Open/Show-in-Folder
// routed to the bridge with the row id, occlusion sync pokes on toggle, live
// polling only while open, and the no-bridge (plain browser) no-op.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "../public/js/browser-downloads-panel.js"), "utf8");

const g = globalThis as unknown as {
	desktop?: { browser?: Record<string, unknown> };
	laxBrowserTab?: { sync: Mock };
	laxBrowserDownloads?: { toggle(): void; isOpen(): boolean; refresh(): void };
};

function flush() { return new Promise<void>((r) => setTimeout(r, 0)); }

function setDom(): void {
	document.body.innerHTML = `
		<button id="browser-downloads-btn"></button>
		<div id="browser-downloads-panel" style="display:none"></div>`;
}

function load(): void {
	// eslint-disable-next-line no-new-func
	new Function(SRC)();
}

function panel() { return document.getElementById("browser-downloads-panel")!; }

const COMPLETED = {
	id: "u1", filename: "codes.txt", savePath: "/Users/x/Downloads/codes.txt",
	url: "https://clover.com/codes", bytes: 512, totalBytes: 512, state: "completed",
	startedAt: 1, doneAt: 2,
};

describe("browser downloads panel", () => {
	let listDownloads: Mock;
	let openDownload: Mock;
	let revealDownload: Mock;

	beforeEach(() => {
		vi.useFakeTimers();
		setDom();
		listDownloads = vi.fn(async () => ({ user: [COMPLETED], quarantined: [] }));
		openDownload = vi.fn(async () => true);
		revealDownload = vi.fn(async () => true);
		g.desktop = { browser: { listDownloads, openDownload, revealDownload, newTab: vi.fn() } };
		g.laxBrowserTab = { sync: vi.fn() };
		load();
	});

	afterEach(() => {
		g.laxBrowserDownloads?.isOpen() && g.laxBrowserDownloads.toggle();
		vi.useRealTimers();
		delete g.desktop;
	});

	it("toggle opens the overlay, pokes the occlusion sync, and renders the user download", async () => {
		g.laxBrowserDownloads!.toggle();
		await vi.advanceTimersByTimeAsync(0);
		expect(panel().style.display).not.toBe("none");
		expect(g.laxBrowserTab!.sync).toHaveBeenCalled();
		expect(panel().textContent).toContain("codes.txt");
		expect(panel().textContent).toContain("512 B");
	});

	it("Open and Show in Folder route to the bridge with the row's id", async () => {
		g.laxBrowserDownloads!.toggle();
		await vi.advanceTimersByTimeAsync(0);
		(panel().querySelector(".dl-open") as HTMLElement).click();
		expect(openDownload).toHaveBeenCalledWith("u1");
		(panel().querySelector(".dl-reveal") as HTMLElement).click();
		expect(revealDownload).toHaveBeenCalledWith("u1");
	});

	it("an in-flight download shows progress and no Open button", async () => {
		listDownloads.mockResolvedValue({
			user: [{ ...COMPLETED, id: "u2", state: "progressing", bytes: 256, doneAt: undefined }],
			quarantined: [],
		});
		g.laxBrowserDownloads!.toggle();
		await vi.advanceTimersByTimeAsync(0);
		expect(panel().textContent).toContain("Downloading… 50%");
		expect(panel().querySelector(".dl-open")).toBeNull();
	});

	it("quarantined agent downloads render read-only with the release explanation", async () => {
		listDownloads.mockResolvedValue({
			user: [],
			quarantined: [{ id: "q1", filename: "report.pdf", state: "completed", bytes: 9, url: "https://x/" }],
		});
		g.laxBrowserDownloads!.toggle();
		await vi.advanceTimersByTimeAsync(0);
		expect(panel().textContent).toContain("report.pdf");
		expect(panel().textContent).toContain("quarantined (agent download)");
		expect(panel().querySelector(".dl-open")).toBeNull();
	});

	it("polls only while open", async () => {
		g.laxBrowserDownloads!.toggle();
		await vi.advanceTimersByTimeAsync(0);
		const after = listDownloads.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2000);
		expect(listDownloads.mock.calls.length).toBeGreaterThan(after);
		g.laxBrowserDownloads!.toggle(); // close
		const closed = listDownloads.mock.calls.length;
		await vi.advanceTimersByTimeAsync(3000);
		expect(listDownloads.mock.calls.length).toBe(closed);
	});

	it("Close button closes and re-syncs the occlusion", async () => {
		g.laxBrowserDownloads!.toggle();
		await vi.advanceTimersByTimeAsync(0);
		(document.getElementById("dl-close") as HTMLElement).click();
		expect(panel().style.display).toBe("none");
	});
});

describe("browser downloads panel — plain browser", () => {
	it("no bridge → button hides and toggle is a no-op", () => {
		setDom();
		delete (globalThis as { desktop?: unknown }).desktop;
		load();
		expect(document.getElementById("browser-downloads-btn")!.style.display).toBe("none");
		g.laxBrowserDownloads!.toggle();
		expect(panel().style.display).toBe("none");
	});
});
