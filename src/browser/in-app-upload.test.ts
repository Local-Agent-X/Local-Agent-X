/**
 * In-app upload driver (bridge fully mocked). Proves:
 *   - a ref observed as the file input is stamped by identity (no hit-test,
 *     no retries) and the desktop is asked to fill the MARKED input;
 *   - a button ref resolves through the click chain and the desktop is asked
 *     to click its view-DIP point and answer the chooser;
 *   - a click-chain hit that turns out to be a file input goes the input way;
 *   - a ref that neither resolves nor is a file input fails with the snapshot;
 *   - the co-drive lock yields USER_TOOK_WHEEL before anything is sent;
 *   - the desktop's refusal and an empty read-back are reported in words;
 *   - the result names the files that landed, and the mark is read back once.
 * The in-page scripts are string builders (in-app-upload-scripts.ts); their
 * DOM-side results are mocked here by the script's distinguishing text.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./bridge-client.js")>();
	return { ...actual, browserExec: vi.fn(), browserInput: vi.fn(), browserLifecycle: vi.fn(), browserUpload: vi.fn() };
});
vi.mock("./stability.js", () => ({ waitForStability: vi.fn().mockResolvedValue(undefined) }));

import { browserExec, browserLifecycle, browserUpload, BridgeOpError } from "./bridge-client.js";
import { mintUploadMark, uploadRefInApp } from "./in-app-upload.js";
import { fileInputMarkScript, uploadReadbackScript, UPLOAD_MARK_ATTR } from "./in-app-upload-scripts.js";
import { USER_TOOK_WHEEL, type InAppActionContext, type ResolvedTarget } from "./in-app-actions.js";
import { ObservationRegistry, type BrowserObservation, type DurableRef } from "./observation.js";
import type { Page } from "playwright";

const VIEW = "view-u";
const FILES = ["C:\\Users\\me\\Documents\\cv.pdf"];

function makeRef(over: Partial<DurableRef> = {}): DurableRef {
	return {
		id: 7, signature: "sig", role: "button", name: "Upload", tag: "BUTTON", type: "", xpath: "/button[1]",
		inViewport: true, lastSeen: 1, rect: { x: 100, y: 50, width: 80, height: 20 }, ...over,
	};
}
function makeObs(refs: DurableRef[]): BrowserObservation {
	return { url: "https://x/", title: "X", isInitial: false, full: refs, added: [], removed: [], changed: [], offscreenCount: 0, totalCount: refs.length, currentRefs: refs, obstructions: [], dialogs: [], crossOriginIframes: [] };
}
function makeCtx(ref: DurableRef | undefined): InAppActionContext {
	const registry = {
		get: (id: number) => (ref && id === ref.id ? ref : undefined),
		recoverStaleRef: (id: number) => (ref && id === ref.id ? ref : undefined),
		observe: vi.fn().mockResolvedValue(makeObs(ref ? [ref] : [])),
	} as unknown as ObservationRegistry;
	return { viewId: VIEW, page: { url: () => "https://x/" } as unknown as Page, registry, retryDelayMs: 0, settleMs: 0 };
}
function resolved(over: Partial<ResolvedTarget> = {}): ResolvedTarget {
	return { found: true, via: "role", x: 110, y: 55, w: 80, h: 20, dpr: 1, zoom: 1, tag: "BUTTON", type: "", editable: false, ...over };
}

const isMarkScript = (s: string) => s.includes("only-file-input");
const isReadback = (s: string) => s.includes("removeAttribute(p.attr)") && s.includes("multiple");
const isChain = (s: string) => s.includes("ROLE_SEL");
const READBACK_OK = { ok: true, names: ["cv.pdf"], sizes: [2048], multiple: false };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(browserLifecycle).mockResolvedValue({ ping: { ok: true, userActive: false } });
	vi.mocked(browserUpload).mockResolvedValue("input");
	vi.mocked(browserExec).mockImplementation(async (_v, s) => (isReadback(s) ? READBACK_OK : undefined));
});

describe("uploadRefInApp — a ref that is the file input", () => {
	const FILE_REF = makeRef({ role: "textbox", name: "Resume", tag: "INPUT", type: "file", ids: { id: "resume" } });

	it("stamps it by identity, skips the hit-test chain, and asks the desktop for the marked input", async () => {
		vi.mocked(browserExec).mockImplementation(async (_v, s) => {
			if (isMarkScript(s)) return { ok: true, via: "exact", key: 'id="resume"' };
			if (isReadback(s)) return READBACK_OK;
			return undefined;
		});
		const res = await uploadRefInApp(makeCtx(FILE_REF), 7, FILES);
		expect(res.ok).toBe(true);
		expect(res.text).toContain('[7] upload via id="resume" — 1 file: cv.pdf (2.0 KB)');
		expect(res.text).not.toContain("file chooser");
		expect(vi.mocked(browserExec).mock.calls.some(([, s]) => isChain(s))).toBe(false);
		const [viewId, upload] = vi.mocked(browserUpload).mock.calls[0];
		expect(viewId).toBe(VIEW);
		expect(upload.files).toEqual(FILES);
		expect(upload.target).toEqual({ kind: "input" });
		expect(upload.mark).toMatch(/^up-[a-z0-9]+-[a-z0-9]+$/);
		// The mark script and the read-back carry the SAME mark.
		const markScript = vi.mocked(browserExec).mock.calls.find(([, s]) => isMarkScript(s))![1];
		const readback = vi.mocked(browserExec).mock.calls.find(([, s]) => isReadback(s))![1];
		expect(markScript).toContain(JSON.stringify(upload.mark));
		expect(readback).toContain(JSON.stringify(upload.mark));
	});

	it("falls to the click chain when no file input answers to the identity, and still goes the input way on a file-input hit", async () => {
		vi.mocked(browserExec).mockImplementation(async (_v, s) => {
			if (isMarkScript(s)) return { ok: false, error: "not-found" };
			if (isChain(s)) return resolved({ tag: "INPUT", type: "file", via: "xpath" });
			if (isReadback(s)) return READBACK_OK;
			return undefined;
		});
		const res = await uploadRefInApp(makeCtx(FILE_REF), 7, FILES);
		expect(res.ok).toBe(true);
		expect(res.text).toContain("[7] upload via XPath — 1 file");
		expect(vi.mocked(browserUpload).mock.calls[0][1].target).toEqual({ kind: "input" });
	});
});

describe("uploadRefInApp — a control whose click opens the chooser", () => {
	it("resolves the click point and asks the desktop to click it and answer the chooser", async () => {
		vi.mocked(browserExec).mockImplementation(async (_v, s) => {
			if (isChain(s)) return resolved({ x: 100.4, y: 40, zoom: 1.25 });
			if (isReadback(s)) return { ok: true, names: ["a.png", "b.png"], sizes: [10, 2_000_000], multiple: true };
			return undefined;
		});
		vi.mocked(browserUpload).mockResolvedValue("chooser");
		const res = await uploadRefInApp(makeCtx(makeRef()), 7, ["C:\\a.png", "C:\\b.png"]);
		expect(res.ok).toBe(true);
		expect(res.text).toContain('[7] upload via role/name (button "Upload") through the file chooser — 2 files: a.png (10 B), b.png (1.9 MB)');
		expect(res.text).toContain("Page: https://x/");
		const upload = vi.mocked(browserUpload).mock.calls[0][1];
		expect(upload.target).toEqual({ kind: "click", x: 126, y: 50 }); // CSS px × zoom, rounded
		// The chain ran with the mark, so a file-input hit would already be stamped.
		const chain = vi.mocked(browserExec).mock.calls.find(([, s]) => isChain(s))![1];
		expect(chain).toContain(`"mark":${JSON.stringify(upload.mark)}`);
		// A button ref never runs the identity pass first.
		expect(vi.mocked(browserExec).mock.calls.findIndex(([, s]) => isMarkScript(s))).toBe(-1);
	});

	it("tries the identity pass once when the chain misses, then fails with the snapshot and the occluder", async () => {
		vi.mocked(browserExec).mockImplementation(async (_v, s) => {
			if (isChain(s)) return { found: false, occluded: ["role:div#backdrop"] };
			if (isMarkScript(s)) return { ok: false, error: "not-found" };
			return undefined;
		});
		const res = await uploadRefInApp(makeCtx(makeRef()), 7, FILES);
		expect(res.ok).toBe(false);
		expect(res.text).toContain("all resolution strategies failed");
		expect(res.text).toContain("div#backdrop");
		expect(browserUpload).not.toHaveBeenCalled();
	});

	it("a label-named ref that the chain cannot hit but that IS the page's only file input is uploaded by identity", async () => {
		vi.mocked(browserExec).mockImplementation(async (_v, s) => {
			if (isChain(s)) return { found: false, occluded: [] };
			if (isMarkScript(s)) return { ok: true, via: "only-file-input" };
			if (isReadback(s)) return READBACK_OK;
			return undefined;
		});
		const res = await uploadRefInApp(makeCtx(makeRef({ role: "button", name: "Choose file" })), 7, FILES);
		expect(res.ok).toBe(true);
		expect(res.text).toContain("[7] upload via the page's only file input — 1 file");
		expect(vi.mocked(browserUpload).mock.calls[0][1].target).toEqual({ kind: "input" });
	});
});

describe("uploadRefInApp — refusals and reporting", () => {
	it("yields to the human before sending anything when the co-drive lock is held", async () => {
		vi.mocked(browserLifecycle).mockResolvedValue({ ping: { ok: true, userActive: true } });
		const res = await uploadRefInApp(makeCtx(makeRef()), 7, FILES);
		expect(res).toEqual({ ok: false, text: USER_TOOK_WHEEL });
		expect(browserExec).not.toHaveBeenCalled();
		expect(browserUpload).not.toHaveBeenCalled();
	});

	it("reports an unknown ref with a fresh snapshot", async () => {
		const res = await uploadRefInApp(makeCtx(undefined), 99, FILES);
		expect(res.ok).toBe(false);
		expect(res.text).toContain("Ref [99] not found");
		expect(browserUpload).not.toHaveBeenCalled();
	});

	it("relays the desktop's reason when the op is refused there", async () => {
		vi.mocked(browserExec).mockImplementation(async (_v, s) => (isChain(s) ? resolved() : undefined));
		vi.mocked(browserUpload).mockRejectedValue(new BridgeOpError("upload", VIEW, "no file chooser opened within 4000ms of the click — the control may not open a picker"));
		const res = await uploadRefInApp(makeCtx(makeRef()), 7, FILES);
		expect(res).toEqual({ ok: false, text: "[7] upload failed: no file chooser opened within 4000ms of the click — the control may not open a picker" });
	});

	it("rethrows anything that is not an op refusal (deadlines, closed views) for the tool layer", async () => {
		vi.mocked(browserExec).mockImplementation(async (_v, s) => (isChain(s) ? resolved() : undefined));
		vi.mocked(browserUpload).mockRejectedValue(new Error("browser upload timed out after 8000ms"));
		await expect(uploadRefInApp(makeCtx(makeRef()), 7, FILES)).rejects.toThrow("timed out");
	});

	it("says so when the input holds nothing after the op", async () => {
		vi.mocked(browserExec).mockImplementation(async (_v, s) => {
			if (isChain(s)) return resolved();
			if (isReadback(s)) return { ok: true, names: [], sizes: [], multiple: false };
			return undefined;
		});
		const res = await uploadRefInApp(makeCtx(makeRef()), 7, FILES);
		expect(res.ok).toBe(false);
		expect(res.text).toContain("holds no file afterwards");
	});
});

describe("upload scripts", () => {
	it("mintUploadMark stays inside the alphabet the desktop accepts", () => {
		expect(mintUploadMark(1_700_000_000_000, 0.123)).toMatch(/^up-[a-z0-9]+-[a-z0-9]+$/);
		expect(mintUploadMark()).not.toBe(mintUploadMark(Date.now(), 0.999));
	});

	it("fileInputMarkScript carries the ref's identity, every strategy, and the mark attribute", () => {
		const ref = makeRef({ tag: "INPUT", type: "file", name: "Resume", ids: { id: "resume", name: "cv" }, xpath: "/form/input[2]" });
		const s = fileInputMarkScript(ref, "up-1-2");
		expect(s).toContain('"mark":"up-1-2"');
		expect(s).toContain(`"attr":"${UPLOAD_MARK_ATTR}"`);
		expect(s).toContain('id=\\"resume\\"'); // the exact selector, via stableSelectors
		expect(s).toContain('"xpath":"/form/input[2]"');
		expect(s).toContain('input[type="file"]');
		for (const via of ['"exact"', '"xpath"', '"name"', '"only-file-input"']) expect(s).toContain(via);
		// A label stands for its control.
		expect(s).toContain("el.control");
	});

	it("uploadReadbackScript reads names and sizes by the mark and clears it, searching same-origin frames too", () => {
		const s = uploadReadbackScript("up-9-9");
		expect(s).toContain('"mark":"up-9-9"');
		expect(s).toContain("removeAttribute(p.attr)");
		expect(s).toContain("f.name");
		expect(s).toContain("f.size");
		expect(s).toContain("sameOriginRoots()");
	});
});
