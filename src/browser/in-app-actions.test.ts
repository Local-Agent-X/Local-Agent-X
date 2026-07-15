/**
 * In-app A2 driver + resolution-chain tests (bridge fully mocked). Proves:
 *   - the pure coordinate converter (zoom/DPR) and select-all modifier;
 *   - the resolution chain: found-via, miss→retry→found, total-miss refuses a
 *     blind click;
 *   - real-input sequences: click ordering, fill (focus + select-all + Delete +
 *     per-char, platform modifier), contenteditable char typing;
 *   - <select> via isolated-world eval (NOT typed), with pre-exec arbitration;
 *   - file-input routed to the human;
 *   - userActive propagation on the input path and the pre-exec (select) path;
 *   - clickByText found / scroll-retry / budget cutoff;
 *   - scroll deltas + strings and the userActive short-circuit.
 * The in-page SCRIPTS themselves are pure string builders (in-app-observe.ts);
 * here we mock browserExec to stand in for their DOM-side result.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./bridge-client.js")>();
	return {
		...actual,
		browserExec: vi.fn(),
		browserInput: vi.fn(),
		browserLifecycle: vi.fn(),
	};
});
// The observation/stability pipeline is exercised elsewhere; here it must not
// touch the fake page. waitForStability no-ops so the drivers run in isolation.
vi.mock("./stability.js", () => ({ waitForStability: vi.fn().mockResolvedValue(undefined) }));

import { browserExec, browserInput, browserLifecycle } from "./bridge-client.js";
import {
	cssToViewDip,
	selectAllModifier,
	isViewUserActive,
	clickRefInApp,
	fillRefInApp,
	clickTextInApp,
	scrollInApp,
	USER_TOOK_WHEEL,
	FILE_INPUT_NEEDS_HUMAN,
	type InAppActionContext,
	type ResolvedTarget,
} from "./in-app-actions.js";
import { CREDENTIAL_FOCUS_SCRIPT } from "./in-app-backend.js";
import { ObservationRegistry, type BrowserObservation, type DurableRef } from "./observation.js";
import type { Page } from "playwright";

const VIEW = "view-x";

function makeRef(over: Partial<DurableRef> = {}): DurableRef {
	return {
		id: 1,
		signature: "sig",
		role: "button",
		name: "Submit",
		tag: "BUTTON",
		type: "",
		xpath: "/button[1]",
		inViewport: true,
		lastSeen: 1,
		rect: { x: 100, y: 50, width: 80, height: 20 },
		...over,
	};
}

function makeObs(refs: DurableRef[]): BrowserObservation {
	return {
		url: "https://x/",
		title: "X",
		isInitial: false,
		full: refs,
		added: [],
		removed: [],
		changed: [],
		offscreenCount: 0,
		totalCount: refs.length,
		currentRefs: refs,
		obstructions: [],
		dialogs: [],
		crossOriginIframes: [],
	};
}

function makeCtx(ref: DurableRef | undefined, over: Partial<InAppActionContext> = {}): InAppActionContext {
	const obs = makeObs(ref ? [ref] : []);
	const registry = {
		get: (id: number) => (ref && id === ref.id ? ref : undefined),
		observe: vi.fn().mockResolvedValue(obs),
	} as unknown as ObservationRegistry;
	const page = { url: () => "https://x/" } as unknown as Page;
	return { viewId: VIEW, page, registry, retryDelayMs: 0, settleMs: 0, ...over };
}

function resolved(over: Partial<ResolvedTarget> = {}): ResolvedTarget {
	return { found: true, via: "role", x: 110, y: 55, w: 80, h: 20, dpr: 1, zoom: 1, tag: "BUTTON", type: "", editable: false, ...over };
}

/** browserInput event types in call order. */
function inputTypes(): string[] {
	return vi.mocked(browserInput).mock.calls.map(([, e]) => e.type);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(browserInput).mockResolvedValue(undefined);
	vi.mocked(browserExec).mockResolvedValue(undefined);
	vi.mocked(browserLifecycle).mockResolvedValue({ ping: { ok: true, userActive: false } });
});

// ── Pure helpers ─────────

describe("cssToViewDip", () => {
	it("is identity at zoom 1 regardless of DPR", () => {
		expect(cssToViewDip(100, 50, 1, 1)).toEqual({ x: 100, y: 50 });
		expect(cssToViewDip(100, 50, 1, 2)).toEqual({ x: 100, y: 50 });
	});
	it("multiplies by zoom and ignores DPR", () => {
		expect(cssToViewDip(100, 40, 1.25, 1)).toEqual({ x: 125, y: 50 });
		expect(cssToViewDip(80, 80, 1.25, 2)).toEqual({ x: 100, y: 100 });
	});
});

describe("selectAllModifier", () => {
	it("is meta on darwin, control elsewhere", () => {
		expect(selectAllModifier("darwin")).toBe("meta");
		expect(selectAllModifier("win32")).toBe("control");
		expect(selectAllModifier("linux")).toBe("control");
	});
});

describe("isViewUserActive", () => {
	it("returns true only when the ping reports the human is driving", async () => {
		vi.mocked(browserLifecycle).mockResolvedValue({ ping: { ok: true, userActive: true } });
		expect(await isViewUserActive(VIEW)).toBe(true);
	});
	it("returns false when userActive is absent/false", async () => {
		vi.mocked(browserLifecycle).mockResolvedValue({ ping: { ok: true } });
		expect(await isViewUserActive(VIEW)).toBe(false);
	});
	it("fails closed to false when the ping throws", async () => {
		vi.mocked(browserLifecycle).mockRejectedValue(new Error("bridge down"));
		expect(await isViewUserActive(VIEW)).toBe(false);
	});
});

// ── Resolution chain ─────────

describe("clickRefInApp — resolution + real input", () => {
	it("clicks a role-resolved ref and reports the via message", async () => {
		vi.mocked(browserExec).mockResolvedValue(resolved());
		const res = await clickRefInApp(makeCtx(makeRef()), 1);
		expect(res.ok).toBe(true);
		expect(res.text).toContain(`[1] click via role/name (button "Submit")`);
		// mouseMove → mouseDown → mouseUp at the converted DIP coords (zoom 1 ⇒ identity).
		expect(inputTypes()).toEqual(["mouseMove", "mouseDown", "mouseUp"]);
		const first = vi.mocked(browserInput).mock.calls[0][1];
		expect(first).toMatchObject({ type: "mouseMove", x: 110, y: 55 });
	});

	it("falls through a hit-test miss and succeeds on a later pass", async () => {
		vi.mocked(browserExec)
			.mockResolvedValueOnce({ found: false, occluded: ["role"] })
			.mockResolvedValueOnce({ found: false })
			.mockResolvedValueOnce(resolved({ via: "xpath" }));
		const res = await clickRefInApp(makeCtx(makeRef()), 1);
		expect(res.ok).toBe(true);
		expect(res.text).toContain("[1] click via XPath");
		expect(vi.mocked(browserExec).mock.calls.filter(([, s]) => s.includes("ROLE_SEL")).length).toBe(3);
	});

	it("refuses a blind click when every strategy misses (all passes)", async () => {
		vi.mocked(browserExec).mockResolvedValue({ found: false, occluded: ["coords"] });
		const res = await clickRefInApp(makeCtx(makeRef()), 1);
		expect(res.ok).toBe(false);
		expect(res.text).toContain("all resolution strategies failed");
		expect(browserInput).not.toHaveBeenCalled();
	});

	it("returns a not-found result for an unknown ref without touching the bridge", async () => {
		const res = await clickRefInApp(makeCtx(undefined), 99);
		expect(res.ok).toBe(false);
		expect(res.text).toContain("Ref [99] not found");
		expect(browserExec).not.toHaveBeenCalled();
	});

	it("surfaces USER_TOOK_WHEEL when the desktop refuses the input (human driving)", async () => {
		vi.mocked(browserExec).mockResolvedValue(resolved());
		vi.mocked(browserInput).mockResolvedValueOnce({ userActive: true });
		const res = await clickRefInApp(makeCtx(makeRef()), 1);
		expect(res).toEqual({ ok: false, text: USER_TOOK_WHEEL });
	});
});

// ── fill ─────────

describe("fillRefInApp — typed input, select, contenteditable, file", () => {
	it("focus-clicks then select-all + Delete + per-char types (meta on darwin)", async () => {
		vi.mocked(browserExec).mockResolvedValue(resolved({ tag: "INPUT", type: "text" }));
		const ctx = makeCtx(makeRef({ role: "textbox", name: "Email" }), { platform: "darwin" });
		const res = await fillRefInApp(ctx, 1, "hi");
		expect(res.ok).toBe(true);
		expect(res.text).toBe(`[1] fill via role/name (textbox "Email") — 2 chars`);
		expect(inputTypes()).toEqual([
			"mouseMove", "mouseDown", "mouseUp",
			"keyDown", "keyUp", // select-all "a"
			"keyDown", "keyUp", // Delete
			"char", "char", // h, i
		]);
		const calls = vi.mocked(browserInput).mock.calls.map(([, e]) => e);
		expect(calls[3]).toMatchObject({ type: "keyDown", keyCode: "a", modifiers: ["meta"] });
		expect(calls[5]).toMatchObject({ type: "keyDown", keyCode: "Delete" });
		expect(calls[7]).toMatchObject({ type: "char", keyCode: "h" });
		expect(calls[8]).toMatchObject({ type: "char", keyCode: "i" });
	});

	it("uses control as the select-all modifier off darwin", async () => {
		vi.mocked(browserExec).mockResolvedValue(resolved({ tag: "INPUT", type: "text" }));
		const ctx = makeCtx(makeRef({ role: "textbox", name: "Email" }), { platform: "win32" });
		await fillRefInApp(ctx, 1, "x");
		const a = vi.mocked(browserInput).mock.calls.map(([, e]) => e).find((e) => "keyCode" in e && e.keyCode === "a");
		expect(a).toMatchObject({ modifiers: ["control"] });
	});

	it("fills a <select> via isolated-world eval — never typed", async () => {
		vi.mocked(browserExec).mockImplementation(async (_v, s) => {
			if (s.includes("ROLE_SEL")) return resolved({ tag: "SELECT" });
			if (s.includes("no-matching-option")) return { ok: true, selected: ["opt1"] };
			return undefined;
		});
		const ctx = makeCtx(makeRef({ role: "combobox", name: "Country" }));
		const res = await fillRefInApp(ctx, 1, "opt1");
		expect(res.ok).toBe(true);
		expect(res.text).toBe(`[1] fill via role/name (combobox "Country") — 4 chars`);
		expect(browserInput).not.toHaveBeenCalled();
		expect(vi.mocked(browserExec).mock.calls.some(([, s]) => s.includes("no-matching-option"))).toBe(true);
	});

	it("types into a contenteditable via char events", async () => {
		vi.mocked(browserExec).mockResolvedValue(resolved({ tag: "DIV", via: "xpath", editable: true }));
		const ctx = makeCtx(makeRef({ role: "textbox", name: "Body" }));
		const res = await fillRefInApp(ctx, 1, "z");
		expect(res.ok).toBe(true);
		expect(res.text).toBe(`[1] fill via XPath — 1 chars`);
		expect(inputTypes()).toContain("char");
		expect(vi.mocked(browserInput).mock.calls.map(([, e]) => e).at(-1)).toMatchObject({ type: "char", keyCode: "z" });
	});

	it("routes a file input to the human without dispatching input", async () => {
		vi.mocked(browserExec).mockResolvedValue(resolved({ tag: "INPUT", type: "file" }));
		const res = await fillRefInApp(makeCtx(makeRef({ role: "button", name: "Upload" })), 1, "/tmp/x");
		expect(res.ok).toBe(false);
		expect(res.text).toContain(FILE_INPUT_NEEDS_HUMAN);
		expect(browserInput).not.toHaveBeenCalled();
	});

	it("pre-exec arbitration: a <select> fill aborts BEFORE mutating when the human is driving", async () => {
		vi.mocked(browserLifecycle).mockResolvedValue({ ping: { ok: true, userActive: true } });
		vi.mocked(browserExec).mockImplementation(async (_v, s) => (s.includes("ROLE_SEL") ? resolved({ tag: "SELECT" }) : undefined));
		const ctx = makeCtx(makeRef({ role: "combobox", name: "Country" }));
		const res = await fillRefInApp(ctx, 1, "opt1");
		expect(res).toEqual({ ok: false, text: USER_TOOK_WHEEL });
		// The mutating selectFillScript must NOT have run.
		expect(vi.mocked(browserExec).mock.calls.every(([, s]) => !s.includes("no-matching-option"))).toBe(true);
	});
});

// ── clickByText ─────────

describe("clickTextInApp — budget + scroll retry", () => {
	it("clicks the first matching element and reports its role", async () => {
		vi.mocked(browserExec).mockResolvedValue({ found: true, role: "button", x: 200, y: 100, dpr: 1, zoom: 1 });
		const res = await clickTextInApp(makeCtx(makeRef()), "Sign in");
		expect(res.ok).toBe(true);
		expect(res.text).toContain(`clicked button "Sign in"`);
		expect(inputTypes()).toEqual(["mouseMove", "mouseDown", "mouseUp"]);
		expect(vi.mocked(browserInput).mock.calls[0][1]).toMatchObject({ x: 200, y: 100 });
	});

	it("scrolls a viewport and retries when the first pass misses", async () => {
		let searches = 0;
		vi.mocked(browserExec).mockImplementation(async (_v, s) => {
			if (s.includes("CLICKABLE")) { searches += 1; return searches >= 2 ? { found: true, role: "link", x: 10, y: 20, dpr: 1, zoom: 1 } : { found: false }; }
			return undefined; // the scroll-one-viewport script
		});
		const res = await clickTextInApp(makeCtx(makeRef()), "Next");
		expect(res.ok).toBe(true);
		expect(res.text).toContain(`clicked link "Next"`);
		expect(vi.mocked(browserExec).mock.calls.some(([, s]) => s.includes("scrollBy"))).toBe(true);
	});

	it("stops at the wall-clock budget and returns a clean not-found", async () => {
		vi.mocked(browserExec).mockResolvedValue({ found: false });
		const res = await clickTextInApp(makeCtx(makeRef()), "Ghost", 0);
		expect(res.ok).toBe(false);
		expect(res.text).toContain(`no clickable element matching text "Ghost"`);
		// Budget 0 → one search, no scroll probe.
		expect(vi.mocked(browserExec).mock.calls.some(([, s]) => s.includes("scrollBy"))).toBe(false);
	});
});

// ── scroll ─────────

describe("scrollInApp — deltas + strings", () => {
	const metrics = { vw: 1280, vh: 800, top: 100, height: 5000, dpr: 1, zoom: 1 };

	it("scrolls down a default viewport amount (wheel delta inverted)", async () => {
		vi.mocked(browserExec).mockResolvedValue(metrics);
		const out = await scrollInApp(makeCtx(undefined), { direction: "down" });
		expect(out).toBe("Scrolled down (600px)");
		expect(vi.mocked(browserInput).mock.calls[0][1]).toMatchObject({ type: "mouseWheel", x: 640, y: 400, deltaY: -600 });
	});

	it("scrolls up with an inverted positive wheel delta", async () => {
		vi.mocked(browserExec).mockResolvedValue(metrics);
		const out = await scrollInApp(makeCtx(undefined), { direction: "up" });
		expect(out).toBe("Scrolled up (600px)");
		expect(vi.mocked(browserInput).mock.calls[0][1]).toMatchObject({ deltaY: 600 });
	});

	it("scroll-to-top wheels back by the current scrollTop", async () => {
		vi.mocked(browserExec).mockResolvedValue(metrics);
		const out = await scrollInApp(makeCtx(undefined), { direction: "top" });
		expect(out).toBe("Scrolled top (600px)");
		expect(vi.mocked(browserInput).mock.calls[0][1]).toMatchObject({ deltaY: 100 });
	});

	it("scrolls a ref into view via the resolution round-trip", async () => {
		vi.mocked(browserExec).mockResolvedValue(resolved());
		const out = await scrollInApp(makeCtx(makeRef()), { refId: 1 });
		expect(out).toBe("Scrolled ref [1] into view");
		expect(browserInput).not.toHaveBeenCalled();
	});

	it("short-circuits to USER_TOOK_WHEEL when the human is driving", async () => {
		vi.mocked(browserExec).mockResolvedValue(metrics);
		vi.mocked(browserInput).mockResolvedValue({ userActive: true });
		const out = await scrollInApp(makeCtx(undefined), { direction: "down" });
		expect(out).toBe(USER_TOOK_WHEEL);
	});
});

// ── KB1 credential-focus script: REAL execution of the walk (not mocked) ─────
// The script is a JS-string IIFE; we execute it verbatim against fabricated DOM
// nodes via `new Function("document", "return " + script)`, so the actual
// iframe/shadow walk logic runs. `document` is injected as the sole free global.

function runCredentialScript(activeElement: unknown): boolean {
	const fn = new Function("document", `return ${CREDENTIAL_FOCUS_SCRIPT}`) as (doc: unknown) => boolean;
	return fn({ activeElement });
}
/** A minimal Element-like node. `getAttribute` returns attrs; unknown → "". */
function el(tagName: string, attrs: Record<string, string> = {}, extra: Record<string, unknown> = {}): unknown {
	return { tagName, getAttribute: (n: string) => attrs[n] ?? "", ...extra };
}

describe("CREDENTIAL_FOCUS_SCRIPT — executed walk (KB1)", () => {
	it("(a) blocks a focused <input type=password>", () => {
		expect(runCredentialScript(el("INPUT", { type: "password" }))).toBe(true);
	});

	it("(b) blocks autocomplete=current-password / new-password on a text input", () => {
		expect(runCredentialScript(el("INPUT", { type: "text", autocomplete: "current-password" }))).toBe(true);
		expect(runCredentialScript(el("INPUT", { type: "text", autocomplete: "new-password" }))).toBe(true);
	});

	it("(c/R1) FAILS CLOSED on a focused cross-origin iframe (contentDocument null OR throws)", () => {
		expect(runCredentialScript(el("IFRAME", {}, { contentDocument: null }))).toBe(true);
		const throwing = el("IFRAME", {}, {});
		Object.defineProperty(throwing, "contentDocument", {
			get() { throw new Error("cross-origin"); },
		});
		expect(runCredentialScript(throwing)).toBe(true);
	});

	it("descends a SAME-origin iframe to inspect its focused field", () => {
		const inner = { activeElement: el("INPUT", { type: "password" }) };
		expect(runCredentialScript(el("IFRAME", {}, { contentDocument: inner }))).toBe(true);
		const innerText = { activeElement: el("INPUT", { type: "text" }) };
		expect(runCredentialScript(el("IFRAME", {}, { contentDocument: innerText }))).toBe(false);
	});

	it("(d/R2) descends an open shadow root to catch a shadow-DOM password", () => {
		const host = el("MY-LOGIN", {}, { shadowRoot: { activeElement: el("INPUT", { type: "password" }) } });
		expect(runCredentialScript(host)).toBe(true);
	});

	it("(e) proceeds (false) when a plain text input is focused", () => {
		expect(runCredentialScript(el("INPUT", { type: "text" }))).toBe(false);
	});

	it("proceeds when nothing focusable is active (e.g. BODY)", () => {
		expect(runCredentialScript(el("BODY"))).toBe(false);
	});
});
