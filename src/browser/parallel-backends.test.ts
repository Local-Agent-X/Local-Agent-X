/**
 * Parallel in-app backends (chunk M1) — TWO ElectronInAppBackend instances on
 * distinct viewIds (view-sessA-p1 / view-sessB-p2, distinct profile partitions)
 * driving CONCURRENTLY with no cross-talk. Unlike in-app-backend.test.ts this
 * does NOT mock bridge-client: it wires the REAL bridge-client over a fake
 * desktop transport (process.send capture + process.emit("message") replies),
 * so the correlation-by-(id, viewId) + view-scoped rejection paths are exercised
 * for real. Proves:
 *   - each backend has its OWN ObservationRegistry: a ref minted only in A
 *     (ref [2]) is unknown to B (B holds only ref [1]) — no shared singleton.
 *   - concurrent navigate/observe interleave correctly, keyed by viewId — each
 *     backend sees only its own page's url/title/elements.
 *   - aborting + closing A does NOT reject B's still-pending op (view-scoped
 *     rejection in bridge-client, the seam resetWedgedBrowser rides on).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ElectronInAppBackend } from "./in-app-backend.js";
import { browserAbort, browserLifecycle, browserNavigate } from "./bridge-client.js";
import type { RawElement } from "./extract.js";

const VIEW_A = "view-sessA-p1";
const VIEW_B = "view-sessB-p2";
const URL_A = "https://a.example.com/";
const URL_B = "https://b.example.net/";
const TITLE_A = "Site A";
const TITLE_B = "Site B";

// A has TWO interactive elements → refs [1],[2]; B has ONE → ref [1] only.
// So ref [2] can only ever exist in A's registry — the cross-talk probe.
const RAW_A: RawElement[] = [
	{ role: "button", name: "A-Submit", tag: "BUTTON", type: "", xpath: "/button[1]",
		signature: "button|A-Submit|BUTTON|form", inViewport: true, rect: { x: 10, y: 10, width: 80, height: 20 } },
	{ role: "textbox", name: "A-Email", tag: "INPUT", type: "email", xpath: "/input[1]",
		signature: "textbox|A-Email|INPUT|form", inViewport: true, rect: { x: 10, y: 40, width: 160, height: 20 } },
];
const RAW_B: RawElement[] = [
	{ role: "button", name: "B-Only", tag: "BUTTON", type: "", xpath: "/button[1]",
		signature: "button|B-Only|BUTTON|form", inViewport: true, rect: { x: 10, y: 10, width: 80, height: 20 } },
];

function urlFor(viewId: string): string { return viewId === VIEW_A ? URL_A : URL_B; }
function titleFor(viewId: string): string { return viewId === VIEW_A ? TITLE_A : TITLE_B; }
function rawFor(viewId: string): RawElement[] { return viewId === VIEW_A ? RAW_A : RAW_B; }

/** Isolated-world exec result, routed by the canonical script's markers +
 *  the calling viewId (so A and B get different element sets). */
function routeExec(viewId: string, script: string): unknown {
	if (script.includes("computeSignature")) return rawFor(viewId);   // extract.ts
	if (script.includes("document.title")) return titleFor(viewId);
	if (script.includes("MutationObserver")) return true;             // stability DOM-quiet
	if (script.includes("readyState")) return true;                   // stability spinner poll
	if (script.includes("xpathOf")) return [];                        // modal-detector
	if (script.includes("'iframe, frame'")) return [];                // iframe-detector
	if (script.includes("occluded")) {                                // A2 resolution chain
		return { found: true, via: "role", x: 20, y: 15, w: 80, h: 20, dpr: 1, zoom: 1, tag: "BUTTON", type: "", editable: false };
	}
	return undefined;
}

// ── Fake desktop transport over the real bridge-client ─────────
const sent: Array<Record<string, unknown>> = [];
let autoRespond = true;
let prevSend: typeof process.send;
let prevBridgeEnv: string | undefined;

/** Compute + emit the desktop's reply for one outbound request. */
function respond(msg: Record<string, unknown>): void {
	const id = msg.id as number;
	const viewId = msg.viewId as string;
	// The strict Process.emit overload demands a SendHandle; the raw EventEmitter
	// surface is what the bridge-client listener actually sees for IPC messages.
	const raw = process as unknown as { emit(event: string, ...args: unknown[]): boolean };
	const emit = (reply: Record<string, unknown>) => raw.emit("message", { id, ...reply });
	switch (msg.type) {
		case "lax:browser-lifecycle": {
			const op = msg.op as string;
			if (op === "create") {
				emit({ type: "lax:browser-lifecycle-result", ok: true,
					view: { viewId, partition: `persist:lax-profile-${viewId}`, url: "", title: "", attached: false, agentDriven: true } });
			} else if (op === "ping") {
				emit({ type: "lax:browser-lifecycle-result", ok: true, ping: { ok: true, url: urlFor(viewId), title: titleFor(viewId) } });
			} else {
				emit({ type: "lax:browser-lifecycle-result", ok: true });
			}
			return;
		}
		case "lax:browser-navigate":
			emit({ type: "lax:browser-navigate-result", ok: true, url: urlFor(viewId), title: titleFor(viewId) });
			return;
		case "lax:browser-exec":
			emit({ type: "lax:browser-exec-result", ok: true, result: routeExec(viewId, msg.script as string) });
			return;
		case "lax:browser-input":
			emit({ type: "lax:browser-input-result", ok: true });
			return;
		case "lax:browser-capture":
			emit({ type: "lax:browser-capture-result", ok: true, pngB64: "AAAA" });
			return;
	}
}

beforeAll(() => {
	prevBridgeEnv = process.env.LAX_DESKTOP_BRIDGE;
	process.env.LAX_DESKTOP_BRIDGE = "1";
	prevSend = process.send;
	// browserBridgeAvailable() checks typeof process.send === "function".
	process.send = ((msg: Record<string, unknown>) => {
		sent.push(msg);
		if (autoRespond && typeof msg.type === "string") queueMicrotask(() => respond(msg));
		return true;
	}) as typeof process.send;
});

afterAll(() => {
	process.send = prevSend;
	if (prevBridgeEnv === undefined) delete process.env.LAX_DESKTOP_BRIDGE;
	else process.env.LAX_DESKTOP_BRIDGE = prevBridgeEnv;
	// NOTE: do NOT removeAllListeners("message") — vitest's fork pool uses the
	// process "message" channel too; bridge-client's listener is a harmless
	// coexisting subscriber that only reacts to its own RESULT_TYPES.
});

describe("parallel ElectronInAppBackend instances (M1)", () => {
	let backendA: ElectronInAppBackend;
	let backendB: ElectronInAppBackend;
	let laxDir: string;
	let prevLaxDir: string | undefined;

	beforeEach(() => {
		laxDir = mkdtempSync(join(tmpdir(), "lax-parallel-test-"));
		prevLaxDir = process.env.LAX_DATA_DIR;
		process.env.LAX_DATA_DIR = laxDir;
		sent.length = 0;
		autoRespond = true;
		backendA = new ElectronInAppBackend("sessA", "p1", VIEW_A);
		backendB = new ElectronInAppBackend("sessB", "p2", VIEW_B);
	});

	afterEach(() => {
		if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
		else process.env.LAX_DATA_DIR = prevLaxDir;
		rmSync(laxDir, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("each backend creates its OWN view on its OWN profile partition", async () => {
		await backendA.navigate(URL_A);
		await backendB.navigate(URL_B);
		const creates = sent.filter((m) => m.type === "lax:browser-lifecycle" && m.op === "create");
		expect(creates.map((m) => m.viewId).sort()).toEqual([VIEW_A, VIEW_B]);
		expect(creates.find((m) => m.viewId === VIEW_A)!.partition).toBe("persist:lax-profile-p1");
		expect(creates.find((m) => m.viewId === VIEW_B)!.partition).toBe("persist:lax-profile-p2");
	});

	it("registries are independent: a ref minted only in A is unknown to B", async () => {
		await backendA.navigate(URL_A);
		await backendB.navigate(URL_B);
		const snapA = await backendA.snapshot();
		const snapB = await backendB.snapshot();

		// A sees its own two elements; B sees its own single one — no bleed.
		expect(snapA).toContain("A-Submit");
		expect(snapA).toContain("A-Email");
		expect(snapA).not.toContain("B-Only");
		expect(snapB).toContain("B-Only");
		expect(snapB).not.toContain("A-Submit");

		// B's ref counter is its OWN — B's single element is ref [1], not [3];
		// a shared module-singleton registry would have continued A's numbering.
		expect(snapB).toContain("[1]<button>B-Only</button>");

		// Ref [2] exists ONLY in A. Resolving it in A works; B has no such ref
		// and refuses WITHOUT touching the page — the cross-talk proof.
		const inB = await backendB.clickByRef(2);
		expect(inB.ok).toBe(false);
		expect(inB.text).toContain("Ref [2] not found");
		const execsBefore = sent.filter((m) => m.type === "lax:browser-exec" && m.viewId === VIEW_B).length;

		const inA = await backendA.clickByRef(2);
		expect(inA.ok).toBe(true);
		expect(inA.text).toContain("[2]");
		// B's refusal issued no further exec on B's view (pure registry miss).
		const execsAfter = sent.filter((m) => m.type === "lax:browser-exec" && m.viewId === VIEW_B).length;
		expect(execsAfter).toBe(execsBefore);
	});

	it("concurrent navigate/observe interleave correctly, keyed by viewId", async () => {
		// Fire both navigations concurrently — replies race through the shared
		// correlation map but must land on the right backend.
		const [outA, outB] = await Promise.all([backendA.navigate(URL_A), backendB.navigate(URL_B)]);
		expect(outA).toContain(URL_A);
		expect(outB).toContain(URL_B);
		expect(backendA.getCurrentUrl()).toBe(URL_A);
		expect(backendB.getCurrentUrl()).toBe(URL_B);

		const [obsA, obsB] = await Promise.all([backendA.observe(), backendB.observe()]);
		expect(obsA.url).toBe(URL_A);
		expect(obsB.url).toBe(URL_B);
		expect(obsA.currentRefs.map((r) => r.name)).toEqual(["A-Submit", "A-Email"]);
		expect(obsB.currentRefs.map((r) => r.name)).toEqual(["B-Only"]);

		// Every navigate carried its own viewId — no shared "current" state.
		const navs = sent.filter((m) => m.type === "lax:browser-navigate");
		expect(navs.find((m) => m.url === URL_A)!.viewId).toBe(VIEW_A);
		expect(navs.find((m) => m.url === URL_B)!.viewId).toBe(VIEW_B);
	});

	it("aborting + closing A does not reject B's still-pending op", async () => {
		await backendA.navigate(URL_A);
		await backendB.navigate(URL_B);

		// Hold the next reply so B has a genuinely in-flight op.
		autoRespond = false;
		const pendingB = browserNavigate(VIEW_B, URL_B);
		let bSettled = false;
		void pendingB.then(() => { bSettled = true; }, () => { bSettled = true; });

		// resetWedgedBrowser(A)'s mechanism: fire-and-forget abort + a close that
		// rejects ONLY A's pending ops (rejectPendingForView).
		browserAbort(VIEW_A);
		const closeA = browserLifecycle("close", VIEW_A);
		void closeA.catch(() => {});

		// Let microtasks flush; B must still be pending (its viewId != A's).
		await Promise.resolve();
		await Promise.resolve();
		expect(bSettled).toBe(false);

		// Now release B's reply — it resolves against its own view, unharmed.
		autoRespond = true;
		const bMsg = [...sent].reverse().find((m) => m.type === "lax:browser-navigate" && m.viewId === VIEW_B)!;
		respond(bMsg);
		await expect(pendingB).resolves.toEqual({ url: URL_B, title: TITLE_B });
	});
});
