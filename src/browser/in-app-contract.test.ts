/**
 * In-app cross-seam contract (chunk G1) — the whole in-app path integrates
 * end-to-end over the REAL bridge-client with a MOCKED desktop transport.
 *
 * Unlike in-app-backend.test.ts (which mocks bridge-client wholesale) this
 * wires the genuine bridge-client — its seq/pending correlation, its
 * process.send / process.on("message") plumbing, its typed-error paths — over a
 * fake, STATEFUL desktop pool (process.send capture + process.emit("message")
 * replies, the idiom parallel-backends.test.ts established). And unlike
 * parallel-backends.test.ts (which drives the backend object directly to prove
 * isolation) this drives the seam the way PRODUCTION does: through the
 * tool-layer handlers (handleNavigate / handleObserve / handleClick /
 * handleClickText / handleScreenshot from src/tools/browser-tools/*), proving
 * the tool → backend → bridge → desktop → back round-trip and that the
 * tool-FACING ToolResult strings are shaped as the model expects.
 *
 * Sequence: create view (implicit on first navigate) → navigate → observe
 * (fake RawElements ingested through ObservationRegistry) → clickByRef +
 * clickByText (A2 resolution chain over real input events) → screenshot. All
 * hermetic — no real Electron, Chrome, or CDP.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ElectronInAppBackend } from "./in-app-backend.js";
import type { RawElement } from "./extract.js";
import { handleNavigate } from "../tools/browser-tools/navigation.js";
import { handleObserve } from "../tools/browser-tools/observe.js";
import { handleClick, handleClickText } from "../tools/browser-tools/interact.js";
import { handleScreenshot } from "../tools/browser-tools/page.js";

const VIEW_ID = "view-contract-sess-work";
const PAGE_URL = "https://shop.example.com/cart";
const PAGE_TITLE = "Your Cart";
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// Two interactive elements → refs [1] (button) and [2] (textbox). "Checkout"
// is the click target for both the ref path and the text path.
const RAW_ELEMENTS: RawElement[] = [
	{
		role: "button", name: "Checkout", tag: "BUTTON", type: "",
		xpath: "/main[1]/button[1]", signature: "button|Checkout|BUTTON|main>form",
		inViewport: true, rect: { x: 40, y: 30, width: 120, height: 32 },
	},
	{
		role: "textbox", name: "Promo code", tag: "INPUT", type: "text",
		xpath: "/main[1]/input[1]", signature: "textbox|Promo code|INPUT|main>form",
		inViewport: true, rect: { x: 40, y: 80, width: 200, height: 24 },
	},
];

/**
 * The desktop's isolated-world exec, routed by distinctive markers in the
 * canonical scripts (extract.ts / stability / A2 resolution chain), keyed off
 * the live view state so a post-navigate observe sees the right page.
 */
function routeExec(view: DesktopView, script: string): unknown {
	if (script.includes("computeSignature")) return view.elements;        // extract.ts extractor
	if (script.includes("document.title")) return view.title;
	if (script.includes("MutationObserver")) return true;                 // stability DOM-quiet
	if (script.includes("readyState")) return true;                       // stability spinner poll
	if (script.includes("xpathOf")) return [];                            // modal-detector
	if (script.includes("'iframe, frame'")) return [];                    // iframe-detector
	if (script.includes("current-password")) return false;               // KB1 credential probe: not focused
	if (script.includes("occluded")) {                                    // A2 ref-resolution round-trip
		return { found: true, via: "role", x: 100, y: 46, w: 120, h: 32, dpr: 1, zoom: 1, tag: "BUTTON", type: "", editable: false };
	}
	if (script.includes("CLICKABLE")) {                                   // A2 clickByText search
		return { found: true, role: "button", x: 100, y: 46, dpr: 1, zoom: 1 };
	}
	return undefined;
}

// ── Stateful fake desktop pool over the real bridge-client ─────────
interface DesktopView { url: string; title: string; elements: RawElement[]; created: boolean }

const pool = new Map<string, DesktopView>();
/** Views the DESKTOP created for the human (agentDriven:false in listings). */
const userViewIds = new Set<string>();
const sent: Array<Record<string, unknown>> = [];
const inputEvents: Array<{ type: string }> = [];
let prevSend: typeof process.send;
let prevBridgeEnv: string | undefined;

function respond(msg: Record<string, unknown>): void {
	const id = msg.id as number;
	const viewId = msg.viewId as string;
	const raw = process as unknown as { emit(event: string, ...args: unknown[]): boolean };
	const emit = (reply: Record<string, unknown>) => raw.emit("message", { id, ...reply });
	switch (msg.type) {
		case "lax:browser-lifecycle": {
			const op = msg.op as string;
			if (op === "create") {
				pool.set(viewId, { url: "", title: "", elements: [], created: true });
				emit({ type: "lax:browser-lifecycle-result", ok: true,
					view: { viewId, partition: msg.partition, url: "", title: "", attached: false, agentDriven: true } });
			} else if (op === "ping") {
				const v = pool.get(viewId);
				emit({ type: "lax:browser-lifecycle-result", ok: true, ping: { ok: true, url: v?.url ?? "", title: v?.title ?? "" } });
			} else if (op === "close") {
				pool.delete(viewId);
				emit({ type: "lax:browser-lifecycle-result", ok: true });
			} else if (op === "list") {
				const views = [...pool.entries()].map(([id, v]) => ({
					viewId: id, partition: "persist:lax-profile-work", url: v.url, title: v.title,
					attached: false, agentDriven: !userViewIds.has(id),
				}));
				emit({ type: "lax:browser-lifecycle-result", ok: true, views });
			} else {
				emit({ type: "lax:browser-lifecycle-result", ok: true });
			}
			return;
		}
		case "lax:browser-navigate": {
			// The desktop "loads" the page: bind url/title/elements to the view.
			const v = pool.get(viewId) ?? { url: "", title: "", elements: [], created: true };
			v.url = PAGE_URL;
			v.title = PAGE_TITLE;
			v.elements = RAW_ELEMENTS;
			pool.set(viewId, v);
			emit({ type: "lax:browser-navigate-result", ok: true, url: v.url, title: v.title });
			return;
		}
		case "lax:browser-exec": {
			const v = pool.get(viewId) ?? { url: "", title: "", elements: [], created: true };
			emit({ type: "lax:browser-exec-result", ok: true, result: routeExec(v, msg.script as string) });
			return;
		}
		case "lax:browser-input":
			inputEvents.push(msg.event as { type: string });
			emit({ type: "lax:browser-input-result", ok: true });
			return;
		case "lax:browser-capture":
			emit({ type: "lax:browser-capture-result", ok: true, pngB64: PNG_B64 });
			return;
	}
}

beforeAll(() => {
	prevBridgeEnv = process.env.LAX_DESKTOP_BRIDGE;
	process.env.LAX_DESKTOP_BRIDGE = "1";
	prevSend = process.send;
	process.send = ((msg: Record<string, unknown>) => {
		sent.push(msg);
		if (typeof msg.type === "string") queueMicrotask(() => respond(msg));
		return true;
	}) as typeof process.send;
});

afterAll(() => {
	process.send = prevSend;
	if (prevBridgeEnv === undefined) delete process.env.LAX_DESKTOP_BRIDGE;
	else process.env.LAX_DESKTOP_BRIDGE = prevBridgeEnv;
	// Leave the "message" listener attached — vitest's fork pool shares the
	// channel; bridge-client only reacts to its own RESULT_TYPES.
});

describe("in-app cross-seam contract — tool → backend → real bridge → fake desktop", () => {
	let backend: ElectronInAppBackend;
	let laxDir: string;
	let prevLaxDir: string | undefined;

	beforeEach(() => {
		laxDir = mkdtempSync(join(tmpdir(), "lax-contract-test-"));
		prevLaxDir = process.env.LAX_DATA_DIR;
		process.env.LAX_DATA_DIR = laxDir;
		pool.clear();
		userViewIds.clear();
		sent.length = 0;
		inputEvents.length = 0;
		backend = new ElectronInAppBackend("contract-sess", "work", VIEW_ID);
	});

	afterEach(() => {
		if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
		else process.env.LAX_DATA_DIR = prevLaxDir;
		rmSync(laxDir, { recursive: true, force: true });
	});

	it("navigate (via handleNavigate) creates the view on the profile partition and returns a wrapped snapshot", async () => {
		const result = await handleNavigate(backend, { url: PAGE_URL }, undefined);
		expect(result.isError).toBeFalsy();
		const content = String(result.content);

		// Backend produced the CDP-shaped nav line…
		expect(content).toContain(`Navigated to: ${PAGE_URL}`);
		expect(content).toContain(`Title: ${PAGE_TITLE}`);
		// …and the tool layer auto-appended a snapshot with the ingested elements.
		expect(content).toContain("--- Page snapshot ---");
		expect(content).toContain("[1]<button>Checkout</button>");
		expect(content).toContain("[2]<textbox type=text>Promo code</textbox>");

		// The bridge really created the view on the profile's partition.
		const create = sent.find((m) => m.type === "lax:browser-lifecycle" && m.op === "create");
		expect(create).toBeDefined();
		expect(create!.viewId).toBe(VIEW_ID);
		expect(create!.partition).toBe("persist:lax-profile-work");
		expect(pool.get(VIEW_ID)?.created).toBe(true);
		expect(backend.getCurrentUrl()).toBe(PAGE_URL);
	});

	it("observe (via handleObserve) round-trips the fake RawElements into the role-bucketed tool view", async () => {
		// Drive the backend's navigate (which, unlike the tool handler, does NOT
		// auto-snapshot) so handleObserve is the INITIAL observation and reports
		// the full element set rather than a since-last diff.
		await backend.navigate(PAGE_URL);
		const result = await handleObserve(backend);
		expect(result.isError).toBeFalsy();
		const content = String(result.content);
		expect(content).toContain(`Page: ${PAGE_TITLE} (${PAGE_URL})`);
		expect(content).toContain("Buttons (1):");
		expect(content).toContain(`[1] button "Checkout"`);
		expect(content).toContain("Inputs (1):");
		expect(content).toContain(`[2] textbox "Promo code"`);
	});

	it("clickByRef (via handleClick) resolves ref [1] and dispatches real input events over the bridge", async () => {
		await handleNavigate(backend, { url: PAGE_URL }, undefined); // mints refs [1],[2]
		const result = await handleClick(backend, { ref: 1 });
		expect(result.isError).toBeFalsy();
		expect(String(result.content)).toContain("[1]");
		expect(String(result.content)).toContain("click via role/name");
		// The A2 path drove real synthetic input, not a DOM-eval shortcut.
		expect(inputEvents.map((e) => e.type)).toEqual(["mouseMove", "mouseDown", "mouseUp"]);
	});

	it("clickByText (via handleClickText) resolves by visible text through the same chain", async () => {
		await handleNavigate(backend, { url: PAGE_URL }, undefined);
		const result = await handleClickText(backend, { text: "Checkout" });
		expect(result.isError).toBeFalsy();
		expect(String(result.content).toLowerCase()).toContain("checkout");
		expect(inputEvents.map((e) => e.type)).toEqual(["mouseMove", "mouseDown", "mouseUp"]);
	});

	it("a ref the registry never minted refuses WITHOUT touching the page (isError), through the tool layer", async () => {
		await handleNavigate(backend, { url: PAGE_URL }, undefined);
		const execsBefore = sent.filter((m) => m.type === "lax:browser-exec").length;
		const result = await handleClick(backend, { ref: 99 });
		expect(result.isError).toBe(true);
		expect(String(result.content)).toContain("Ref [99] not found");
		// Pure registry miss — no further exec dispatched to resolve a ghost ref.
		const execsAfter = sent.filter((m) => m.type === "lax:browser-exec").length;
		expect(execsAfter).toBe(execsBefore);
	});

	it("screenshot (via handleScreenshot) captures over the bridge and returns the CDP-shaped saved report", async () => {
		await handleNavigate(backend, { url: PAGE_URL }, undefined);
		const result = await handleScreenshot(backend);
		expect(result.isError).toBeFalsy();
		const content = String(result.content);
		expect(content).toMatch(/^Screenshot captured\n/);
		expect(content).toContain(`URL: ${PAGE_URL}`);
		expect(content).toContain("Engine: electron");
		expect(sent.some((m) => m.type === "lax:browser-capture" && m.viewId === VIEW_ID)).toBe(true);
		// The ToolResult carries the page INLINE on the vision-only _image
		// envelope (never _media — that would auto-deliver the file off-box).
		const shaped = result as { _image?: { mime: string; b64: string; path: string; question: string }; _media?: unknown };
		expect(shaped._image?.mime).toBe("image/jpeg");
		expect(Buffer.from(shaped._image!.b64, "base64").length).toBeGreaterThan(0);
		expect(shaped._image!.path.endsWith(".png")).toBe(true);
		expect(shaped._media).toBeUndefined();
	});

	it("full sequence integrates: navigate → observe → click → screenshot, all over one live view", async () => {
		const nav = await handleNavigate(backend, { url: PAGE_URL }, undefined);
		const obs = await handleObserve(backend);
		const click = await handleClick(backend, { ref: 1 });
		const shot = await handleScreenshot(backend);
		for (const r of [nav, obs, click, shot]) expect(r.isError).toBeFalsy();

		// One view served the whole sequence: exactly one create, and every op
		// addressed the same viewId.
		const creates = sent.filter((m) => m.type === "lax:browser-lifecycle" && m.op === "create");
		expect(creates.length).toBe(1);
		const opViewIds = new Set(sent.map((m) => m.viewId).filter(Boolean));
		expect([...opViewIds]).toEqual([VIEW_ID]);
	});

	it("multi-tab (chunk B): new_tab opens a second live view; tabs lists the user's view; switch_tab takes it over; close spares it", async () => {
		userViewIds.add("view-user-main");
		pool.set("view-user-main", { url: "https://user.example/inbox", title: "User Inbox", elements: [], created: true });

		await handleNavigate(backend, { url: PAGE_URL }, undefined);
		const opened = await backend.newTab(PAGE_URL);
		expect(opened).toContain("Opened new tab (2 tabs total)");
		const creates = sent.filter((m) => m.type === "lax:browser-lifecycle" && m.op === "create");
		expect(creates.map((m) => m.viewId)).toEqual([VIEW_ID, `${VIEW_ID}-t2`]);

		const tabs = await backend.listTabs();
		expect(tabs).toContain("3 tab(s) open:");
		expect(tabs).toContain(`[1] ${PAGE_TITLE} — ${PAGE_URL} ← active`);
		expect(tabs).toContain("[2] User Inbox — https://user.example/inbox [user tab — switch_tab(2) takes control]");

		const switched = await backend.switchTab(2);
		expect(switched).toBe("Switched to tab [2]: User Inbox — https://user.example/inbox");
		// Ops now drive the USER's view over the real bridge.
		const shot = await handleScreenshot(backend);
		expect(shot.isError).toBeFalsy();
		expect(sent.some((m) => m.type === "lax:browser-capture" && m.viewId === "view-user-main")).toBe(true);

		// close(): the agent's owned views die; the user's view survives in the pool.
		await backend.close();
		expect(pool.has(VIEW_ID)).toBe(false);
		expect(pool.has(`${VIEW_ID}-t2`)).toBe(false);
		expect(pool.has("view-user-main")).toBe(true);
	});
});
