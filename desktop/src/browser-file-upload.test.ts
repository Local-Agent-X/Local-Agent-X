/**
 * The upload op over a fake DevTools session: a marked file input gets the
 * files by node id; a click target arms chooser interception, clicks, answers
 * the chooser the click opened and stamps that input; interception is always
 * disarmed again; a marked element that is not a file input, a chooser that
 * never opens and a single-file chooser handed several files are refused.
 */
import { describe, expect, it, vi } from "vitest";
import { CHOOSER_WAIT_MS, isFileInput, uploadIntoView, UPLOAD_MARK_ATTR, type UploadDebugger } from "./browser-file-upload";

type Listener = (event: unknown, method: string, params: unknown) => void;

class FakeDebugger implements UploadDebugger {
	attached = false;
	attachCalls = 0;
	calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
	listeners: Listener[] = [];
	/** Per-method canned replies; a method with none replies {}. */
	replies: Record<string, unknown> = {
		"DOM.getDocument": { root: { nodeId: 1 } },
		"DOM.performSearch": { searchId: "s1", resultCount: 1 },
		"DOM.getSearchResults": { nodeIds: [42] },
		"DOM.describeNode": { node: { nodeName: "INPUT", attributes: ["type", "file", "id", "avatar"] } },
		"DOM.pushNodesByBackendIdsToFrontend": { nodeIds: [77] },
	};
	/** What a click does: by default nothing (no chooser opens). */
	onClick: () => void = () => {};

	isAttached(): boolean { return this.attached; }
	attach(): void { this.attached = true; this.attachCalls++; }
	async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
		this.calls.push({ method, params });
		return this.replies[method] ?? {};
	}
	on(_event: "message", listener: Listener): void { this.listeners.push(listener); }
	removeListener(_event: "message", listener: Listener): void { this.listeners = this.listeners.filter((l) => l !== listener); }
	emit(method: string, params: unknown): void { for (const l of [...this.listeners]) l({}, method, params); }
	sent(method: string) { return this.calls.filter((c) => c.method === method); }
}

const FILES = ["C:\\Users\\me\\Documents\\cv.pdf"];
const MARK = "up-k3x9";

describe("uploadIntoView — a marked <input type=file>", () => {
	it("finds the mark through the DOM domain and hands the files to that node", async () => {
		const dbg = new FakeDebugger();
		const click = vi.fn();
		const out = await uploadIntoView(dbg, { files: FILES, mark: MARK, target: { kind: "input" } }, click);
		expect(out).toEqual({ uploadedVia: "input" });
		expect(dbg.attachCalls).toBe(1);
		expect(dbg.attached).toBe(true); // never detached: the identity override rides this session
		expect(dbg.sent("DOM.performSearch")[0].params).toEqual({ query: `[${UPLOAD_MARK_ATTR}="${MARK}"]` });
		expect(dbg.sent("DOM.setFileInputFiles")[0].params).toEqual({ nodeId: 42, files: FILES });
		expect(dbg.sent("DOM.discardSearchResults")).toHaveLength(1);
		expect(click).not.toHaveBeenCalled();
		// No chooser interception on this path: nothing to arm or disarm.
		expect(dbg.sent("Page.setInterceptFileChooserDialog")).toHaveLength(0);
	});

	it("refuses when the marked element is not a file input, naming what it is", async () => {
		const dbg = new FakeDebugger();
		dbg.replies["DOM.describeNode"] = { node: { nodeName: "BUTTON", attributes: ["type", "button"] } };
		await expect(uploadIntoView(dbg, { files: FILES, mark: MARK, target: { kind: "input" } }, vi.fn()))
			.rejects.toThrow("is <button>, not a file input");
		expect(dbg.sent("DOM.setFileInputFiles")).toHaveLength(0);
	});

	it("refuses when nothing on the page carries the mark", async () => {
		const dbg = new FakeDebugger();
		dbg.replies["DOM.performSearch"] = { searchId: "s2", resultCount: 0 };
		await expect(uploadIntoView(dbg, { files: FILES, mark: MARK, target: { kind: "input" } }, vi.fn()))
			.rejects.toThrow("no longer on the page");
		expect(dbg.sent("DOM.discardSearchResults")[0].params).toEqual({ searchId: "s2" });
	});

	it("refuses a mark that is not server-shaped before touching the session", async () => {
		const dbg = new FakeDebugger();
		await expect(uploadIntoView(dbg, { files: FILES, mark: 'x"]', target: { kind: "input" } }, vi.fn())).rejects.toThrow("unexpected shape");
		await expect(uploadIntoView(dbg, { files: [], mark: MARK, target: { kind: "input" } }, vi.fn())).rejects.toThrow("no files");
		expect(dbg.calls).toEqual([]);
	});
});

describe("uploadIntoView — a control whose click opens the chooser", () => {
	it("arms interception, clicks, answers the chooser's input and stamps it", async () => {
		const dbg = new FakeDebugger();
		const click = vi.fn(() => dbg.emit("Page.fileChooserOpened", { frameId: "f", mode: "selectSingle", backendNodeId: 909 }));
		const out = await uploadIntoView(dbg, { files: FILES, mark: MARK, target: { kind: "click", x: 120, y: 48 } }, click);
		expect(out).toEqual({ uploadedVia: "chooser" });
		expect(click).toHaveBeenCalledWith(120, 48);
		const methods = dbg.calls.map((c) => c.method);
		expect(methods.indexOf("Page.enable")).toBeLessThan(methods.indexOf("Page.setInterceptFileChooserDialog"));
		expect(dbg.sent("Page.setInterceptFileChooserDialog").map((c) => c.params)).toEqual([{ enabled: true }, { enabled: false }]);
		expect(dbg.sent("DOM.setFileInputFiles")[0].params).toEqual({ backendNodeId: 909, files: FILES });
		expect(dbg.sent("DOM.pushNodesByBackendIdsToFrontend")[0].params).toEqual({ backendNodeIds: [909] });
		expect(dbg.sent("DOM.setAttributeValue")[0].params).toEqual({ nodeId: 77, name: UPLOAD_MARK_ATTR, value: MARK });
		expect(dbg.listeners).toEqual([]); // the one-shot listener is gone
	});

	it("gives up when no chooser opens, and leaves interception OFF so the user's own picker works", async () => {
		const dbg = new FakeDebugger();
		await expect(uploadIntoView(dbg, { files: FILES, mark: MARK, target: { kind: "click", x: 1, y: 1 } }, vi.fn(), 20))
			.rejects.toThrow("no file chooser opened within 20ms");
		expect(dbg.sent("Page.setInterceptFileChooserDialog").at(-1)?.params).toEqual({ enabled: false });
		expect(dbg.sent("DOM.setFileInputFiles")).toHaveLength(0);
		expect(dbg.listeners).toEqual([]);
	});

	it("refuses several files to a single-file chooser, and disarms", async () => {
		const dbg = new FakeDebugger();
		const click = () => dbg.emit("Page.fileChooserOpened", { frameId: "f", mode: "selectSingle", backendNodeId: 5 });
		await expect(uploadIntoView(dbg, { files: [...FILES, "C:\\two.txt"], mark: MARK, target: { kind: "click", x: 1, y: 1 } }, click))
			.rejects.toThrow("takes ONE file");
		expect(dbg.sent("DOM.setFileInputFiles")).toHaveLength(0);
		expect(dbg.sent("Page.setInterceptFileChooserDialog").at(-1)?.params).toEqual({ enabled: false });
	});

	it("ignores unrelated debugger traffic while waiting", async () => {
		const dbg = new FakeDebugger();
		const click = () => {
			dbg.emit("Page.frameNavigated", { frame: {} });
			dbg.emit("Page.fileChooserOpened", { frameId: "f", mode: "selectMultiple", backendNodeId: 6 });
		};
		await expect(uploadIntoView(dbg, { files: [...FILES, "C:\\two.txt"], mark: MARK, target: { kind: "click", x: 1, y: 1 } }, click))
			.resolves.toEqual({ uploadedVia: "chooser" });
	});

	it("waits a bounded time by default", () => {
		expect(CHOOSER_WAIT_MS).toBeGreaterThan(1_000);
		expect(CHOOSER_WAIT_MS).toBeLessThan(8_000); // under the server's op ceiling
	});
});

describe("isFileInput", () => {
	it("is an <input> whose type attribute is file, case-insensitively", () => {
		expect(isFileInput({ nodeName: "INPUT", attributes: ["TYPE", "File"] })).toBe(true);
		expect(isFileInput({ nodeName: "input", attributes: ["name", "f", "type", "file"] })).toBe(true);
		expect(isFileInput({ nodeName: "INPUT", attributes: ["type", "text"] })).toBe(false);
		expect(isFileInput({ nodeName: "INPUT", attributes: [] })).toBe(false);
		expect(isFileInput({ nodeName: "BUTTON", attributes: ["type", "file"] })).toBe(false);
		expect(isFileInput(undefined)).toBe(false);
	});
});
