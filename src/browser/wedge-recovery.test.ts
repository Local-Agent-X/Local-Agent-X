/**
 * Wedge recovery (chunk wedge-recovery) — a page-scan wedge must no longer
 * destroy the agent's browser view. Old behavior: BOTH wedge triggers deleted
 * the in-app backend and closed its pooled WebContentsView, so a 10s scan
 * timeout cost the tab, its URL, and all observation state, and the next
 * action failed with "no browser view".
 *
 * New contract (instance.ts resetWedgedBrowser):
 *   - SOFT: a view that still answers a lifecycle ping keeps its backend,
 *     view and URL; only observation state resets, and the abandoned scan's
 *     late completion is discarded by the registry epoch — never committed.
 *   - HARD: a dead ping falls back to teardown, but the backend stays in the
 *     map and the active tab's URL is preserved so the recreated view
 *     re-navigates to it on the next ensureView.
 *
 * Like parallel-backends.test.ts this drives the REAL bridge-client over a
 * fake desktop transport (process.send capture + process.emit replies) —
 * only the routing seams (config / desktop-bridge / profile) are mocked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LAXConfig } from "./../types/lax-config.js";
import type { RawElement } from "./extract.js";

vi.mock("../config.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../config.js")>();
	return {
		...original,
		getRuntimeConfig: () => ({ browserMode: "in-app" } as unknown as LAXConfig),
	};
});

vi.mock("../desktop-bridge.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../desktop-bridge.js")>();
	return { ...original, desktopBridgeAvailable: () => true };
});

vi.mock("./session-owner-registry.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./session-owner-registry.js")>();
	return { ...original, resolveSessionBrowserProfileId: () => "p1" };
});

import { closeAllBrowsers, getBrowserManager, resetWedgedBrowser } from "./instance.js";
import { ElectronInAppBackend } from "./in-app-backend.js";

const SESSION = "sess";
const VIEW_ID = "view-sess-p1";
const URL_1 = "https://one.example.com/page";
const URL_2 = "https://two.example.net/other";

const RAW: RawElement[] = [
	{ role: "button", name: "Submit", tag: "BUTTON", type: "", xpath: "/button[1]",
		signature: "button|Submit|BUTTON|form", inViewport: true, rect: { x: 10, y: 10, width: 80, height: 20 } },
];

/** Isolated-world exec results, routed by the canonical scripts' markers. */
function routeExec(script: string): unknown {
	if (script.includes("computeSignature")) return RAW; // extract.ts
	if (script.includes("document.title")) return "T";
	if (script.includes("MutationObserver")) return true; // stability DOM-quiet
	if (script.includes("readyState")) return true; // stability spinner poll
	if (script.includes("xpathOf")) return []; // modal-detector
	if (script.includes("'iframe, frame'")) return []; // iframe-detector
	return undefined;
}

// ── Fake desktop transport over the real bridge-client ─────────
const sent: Array<Record<string, unknown>> = [];
/** Extract execs held back to simulate a scan wedged mid-extraction. */
const heldExtracts: Array<Record<string, unknown>> = [];
let holdExtract = false;
/** true → lifecycle pings answer ok:false — the view is dead. */
let pingDead = false;
/** URL each view last navigated to, echoed by navigate + ping replies. */
const viewUrls = new Map<string, string>();
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
			if (op === "ping") {
				if (pingDead) emit({ type: "lax:browser-lifecycle-result", ok: false, error: "view destroyed" });
				else emit({ type: "lax:browser-lifecycle-result", ok: true, ping: { ok: true, url: viewUrls.get(viewId) ?? "", title: "T" } });
			} else {
				emit({ type: "lax:browser-lifecycle-result", ok: true });
			}
			return;
		}
		case "lax:browser-navigate":
			viewUrls.set(viewId, msg.url as string);
			emit({ type: "lax:browser-navigate-result", ok: true, url: msg.url, title: "T" });
			return;
		case "lax:browser-exec": {
			const script = msg.script as string;
			if (holdExtract && script.includes("computeSignature")) {
				heldExtracts.push(msg);
				return;
			}
			emit({ type: "lax:browser-exec-result", ok: true, result: routeExec(script) });
			return;
		}
	}
}

const navsSent = () => sent.filter((m) => m.type === "lax:browser-navigate");
const lifecycleSent = (op: string) =>
	sent.filter((m) => m.type === "lax:browser-lifecycle" && m.op === op);

async function waitFor(cond: () => boolean): Promise<void> {
	for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
	expect(cond()).toBe(true);
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
	// Keep the "message" listener — vitest's fork pool shares the channel; the
	// bridge-client listener only reacts to its own RESULT_TYPES.
});

describe("wedge recovery", () => {
	let backend: ElectronInAppBackend;
	let laxDir: string;
	let prevLaxDir: string | undefined;

	beforeEach(() => {
		laxDir = mkdtempSync(join(tmpdir(), "lax-wedge-test-"));
		prevLaxDir = process.env.LAX_DATA_DIR;
		process.env.LAX_DATA_DIR = laxDir;
		sent.length = 0;
		heldExtracts.length = 0;
		holdExtract = false;
		pingDead = false;
		viewUrls.clear();
		backend = getBrowserManager(SESSION) as ElectronInAppBackend;
	});

	afterEach(async () => {
		pingDead = false;
		await closeAllBrowsers();
		if (prevLaxDir === undefined) delete process.env.LAX_DATA_DIR;
		else process.env.LAX_DATA_DIR = prevLaxDir;
		rmSync(laxDir, { recursive: true, force: true });
	});

	it("soft path: a live-pinging wedge recovers in place — same backend, same view, same URL", async () => {
		await backend.navigate(URL_1);
		await backend.observe(); // healthy scan, refs minted

		// Wedge the next scan mid-extraction, exactly where a real page hang bites.
		holdExtract = true;
		const wedged = backend.observe();
		wedged.catch(() => { /* asserted below; avoid an unhandled rejection */ });
		await waitFor(() => heldExtracts.length > 0);

		const outcome = await resetWedgedBrowser(SESSION);
		expect(outcome).toBe("recovered-in-place");

		// The in-flight load was aborted and the view pinged — but NOT closed.
		expect(sent.some((m) => m.type === "lax:browser-abort" && m.viewId === VIEW_ID)).toBe(true);
		expect(lifecycleSent("close")).toHaveLength(0);
		// Same backend, same view, URL intact.
		expect(getBrowserManager(SESSION)).toBe(backend);
		expect(backend.isActive()).toBe(true);
		expect(backend.getCurrentUrl()).toBe(URL_1);

		// Release the abandoned scan: it must be DISCARDED, not committed over
		// the recovered registry.
		holdExtract = false;
		for (const msg of heldExtracts.splice(0)) respond(msg);
		await expect(wedged).rejects.toThrow(/stale page scan discarded/);

		// A subsequent action just works on the SAME view: no recreate, fresh
		// full observation of the same page.
		const createsBefore = lifecycleSent("create").length;
		const obs = await backend.observe();
		expect(obs.url).toBe(URL_1);
		expect(obs.isInitial).toBe(true);
		expect(obs.currentRefs.map((r) => r.name)).toEqual(["Submit"]);
		expect(lifecycleSent("create")).toHaveLength(createsBefore);
	});

	it("hard path: a dead ping tears down but preserves the URL — the recreated view re-navigates to it", async () => {
		await backend.navigate(URL_1);
		pingDead = true;
		const outcome = await resetWedgedBrowser(SESSION);
		expect(outcome).toBe("view-recreated");
		// The dead view WAS closed, but the backend survives for recovery.
		expect(lifecycleSent("close").map((m) => m.viewId)).toContain(VIEW_ID);
		expect(getBrowserManager(SESSION)).toBe(backend);
		expect(backend.isActive()).toBe(false);

		// Next action: ensureView recreates the view AND reloads the last page.
		pingDead = false;
		sent.length = 0;
		const obs = await backend.observe();
		expect(lifecycleSent("create").map((m) => m.viewId)).toEqual([VIEW_ID]);
		expect(navsSent().map((m) => m.url)).toEqual([URL_1]);
		expect(obs.url).toBe(URL_1);
		expect(backend.getCurrentUrl()).toBe(URL_1);
	});

	it("hard path with tabs: the ACTIVE tab's URL is the one preserved", async () => {
		await backend.navigate(URL_1);
		await backend.newTab(URL_2); // second view, now active
		pingDead = true;
		await expect(resetWedgedBrowser(SESSION)).resolves.toBe("view-recreated");
		// Both owned views closed; the surviving first tab reloads the ACTIVE URL.
		expect(lifecycleSent("close").map((m) => m.viewId).sort()).toEqual([VIEW_ID, `${VIEW_ID}-t2`]);
		pingDead = false;
		sent.length = 0;
		await backend.observe();
		expect(navsSent().map((m) => m.url)).toEqual([URL_2]);
		expect(backend.getCurrentUrl()).toBe(URL_2);
	});

	it("a navigate after teardown never double-loads: the new URL wins outright", async () => {
		await backend.navigate(URL_1);
		pingDead = true;
		await resetWedgedBrowser(SESSION);
		pingDead = false;
		sent.length = 0;
		await backend.navigate(URL_2);
		expect(navsSent().map((m) => m.url)).toEqual([URL_2]);
		expect(backend.getCurrentUrl()).toBe(URL_2);
	});

	it("user ✕ (noteViewClosedExternally) also reloads the tab's page on recreation", async () => {
		await backend.navigate(URL_1);
		backend.noteViewClosedExternally(VIEW_ID);
		expect(backend.isActive()).toBe(false);
		sent.length = 0;
		const obs = await backend.observe();
		expect(lifecycleSent("create").map((m) => m.viewId)).toEqual([VIEW_ID]);
		expect(navsSent().map((m) => m.url)).toEqual([URL_1]);
		expect(obs.url).toBe(URL_1);
	});
});
