/**
 * Browser-view message family for the server↔desktop bridge.
 *
 * Dispatched from server-bridge.ts (same transport, same reply idiom:
 * "<type>-result" carrying the request id). Drives the WebContentsView
 * pool (browser-views.ts) on behalf of the server child:
 *   lifecycle / navigate / exec / input / capture / abort.
 *
 * Also wires the per-partition egress guard (browser-partition.ts) to
 * the server's canonical URL policy: wireBrowserEgressEvaluator installs
 * an evaluator that IPC-asks the child ("lax:browser-egress-ask") and
 * FAILS CLOSED — no child, send failure, or a reply slower than the
 * short deadline all deny. Policy lives server-side only.
 */

import type { ChildProcess } from "child_process";
import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent, Rectangle, WebContents } from "electron";

import {
	closeBrowserView,
	createBrowserView,
	getBrowserView,
	hideBrowserView,
	listBrowserViews,
	pingBrowserView,
	setBrowserViewBounds,
	showBrowserView,
	type BrowserViewInfo,
} from "./browser-views";
import { setEgressEvaluator, type EgressDecision } from "./browser-partition";
import { isUserActive, markAgentInput, showAgentCursor } from "./in-app-browser";

// Isolated world for agent scripts — never the main world, so page JS
// can't tamper with (or observe) what the agent executes.
const EXEC_ISOLATED_WORLD_ID = 1901;
const NAVIGATE_DEFAULT_TIMEOUT_MS = 25_000;
const CAPTURE_MAX_B64 = 2 * 1024 * 1024; // mirrors PROBE_MAX_SCREENSHOT_B64
const EGRESS_ASK_DEADLINE_MS = 250;      // per-hop policy ask; fail closed past this

// ── Wire types (mirrored in src/browser/bridge-client.ts) ─────────
export type BrowserLifecycleOp = "create" | "show" | "hide" | "close" | "setBounds" | "ping" | "list";

type BridgeInputModifier = "shift" | "control" | "alt" | "meta";
interface BridgeMouseEvent {
	type: "mouseDown" | "mouseUp" | "mouseMove";
	x: number;
	y: number;
	button?: "left" | "middle" | "right";
	clickCount?: number;
	modifiers?: BridgeInputModifier[];
}
interface BridgeMouseWheelEvent {
	type: "mouseWheel";
	x: number;
	y: number;
	deltaX?: number;
	deltaY?: number;
	modifiers?: BridgeInputModifier[];
}
interface BridgeKeyEvent {
	type: "keyDown" | "keyUp" | "char";
	keyCode: string;
	modifiers?: BridgeInputModifier[];
}
export type BridgeInputEvent = BridgeMouseEvent | BridgeMouseWheelEvent | BridgeKeyEvent;

export interface BrowserLifecycleRequest {
	type: "lax:browser-lifecycle";
	id: number;
	op: BrowserLifecycleOp;
	viewId: string;
	partition?: string;
	bounds?: Rectangle;
}
export interface BrowserNavigateRequest { type: "lax:browser-navigate"; id: number; viewId: string; url: string; timeoutMs?: number }
export interface BrowserExecRequest { type: "lax:browser-exec"; id: number; viewId: string; script: string; world?: "isolated"; allFrames?: boolean }
export interface BrowserInputRequest { type: "lax:browser-input"; id: number; viewId: string; event: BridgeInputEvent }
export interface BrowserCaptureRequest { type: "lax:browser-capture"; id: number; viewId: string }
export interface BrowserAbortRequest { type: "lax:browser-abort"; viewId: string }
export interface BrowserEgressAskResult { type: "lax:browser-egress-ask-result"; id: number; allowed: boolean }

export type BrowserBridgeMessage =
	| BrowserLifecycleRequest
	| BrowserNavigateRequest
	| BrowserExecRequest
	| BrowserInputRequest
	| BrowserCaptureRequest
	| BrowserAbortRequest
	| BrowserEgressAskResult;

const BROWSER_MESSAGE_TYPES = new Set<string>([
	"lax:browser-lifecycle",
	"lax:browser-navigate",
	"lax:browser-exec",
	"lax:browser-input",
	"lax:browser-capture",
	"lax:browser-abort",
	"lax:browser-egress-ask-result",
]);

export function isBrowserBridgeMessage(msg: { type?: string }): msg is BrowserBridgeMessage {
	return typeof msg?.type === "string" && BROWSER_MESSAGE_TYPES.has(msg.type);
}

// ── Egress evaluator (desktop→server ask, fail-closed) ─────────
let egressSeq = 0;
const pendingEgressAsks = new Map<number, (allowed: boolean) => void>();

function askServerEgress(proc: ChildProcess, url: string): Promise<EgressDecision> {
	if (!proc.connected || proc.killed) return Promise.resolve({ allowed: false });
	const id = ++egressSeq;
	return new Promise<EgressDecision>((resolve) => {
		let timer: ReturnType<typeof setTimeout>;
		const finish = (allowed: boolean) => { clearTimeout(timer); pendingEgressAsks.delete(id); resolve({ allowed }); };
		pendingEgressAsks.set(id, finish);
		timer = setTimeout(() => finish(false), EGRESS_ASK_DEADLINE_MS);
		try {
			if (!proc.send({ type: "lax:browser-egress-ask", id, url })) finish(false);
		} catch {
			finish(false); // channel just closed — deny
		}
	});
}

/** Point the partition egress guard at the server child. Called from
 *  attachServerBridge on every (re)spawn so the closure always holds the
 *  live process; a dead/replaced child fails closed inside the ask. */
export function wireBrowserEgressEvaluator(proc: ChildProcess): void {
	setEgressEvaluator((url) => askServerEgress(proc, url));
}

// ── Dispatch ─────────
export async function handleBrowserBridgeMessage(proc: ChildProcess, msg: BrowserBridgeMessage): Promise<void> {
	switch (msg.type) {
		case "lax:browser-egress-ask-result": {
			pendingEgressAsks.get(msg.id)?.(msg.allowed === true);
			return;
		}
		case "lax:browser-abort": {
			// Fire-and-forget by contract: no id, no reply.
			try { requireWebContents(msg.viewId).stop(); } catch { /* view already gone */ }
			return;
		}
		case "lax:browser-lifecycle": {
			reply(proc, "lax:browser-lifecycle-result", msg.id, () => lifecycle(msg));
			return;
		}
		case "lax:browser-navigate": {
			reply(proc, "lax:browser-navigate-result", msg.id, () => navigate(msg));
			return;
		}
		case "lax:browser-exec": {
			// Isolated world only (1901) — never the main world. Default runs in
			// the main frame; allFrames aggregates per same-origin frame (see
			// execSameOriginFrames for the Electron 35 subframe limitation).
			reply(proc, "lax:browser-exec-result", msg.id, async () => ({
				result: msg.allFrames
					? await execSameOriginFrames(requireWebContents(msg.viewId), msg.script)
					: await requireWebContents(msg.viewId).executeJavaScriptInIsolatedWorld(
						EXEC_ISOLATED_WORLD_ID,
						[{ code: msg.script }],
					) as unknown,
			}));
			return;
		}
		case "lax:browser-input": {
			reply(proc, "lax:browser-input-result", msg.id, () => {
				const event = toElectronInputEvent(msg.event);
				if (!event) throw new Error(`unsupported input event type "${(msg.event as { type?: string })?.type}"`);
				// Human-priority co-drive: while the user is driving this view,
				// refuse agent input as a STATUS (not an error) — the client
				// surfaces userActive so the model knows the user took the wheel.
				if (isUserActive(msg.viewId)) return { ok: false, userActive: true };
				const wc = requireWebContents(msg.viewId);
				// Bank the attribution token BEFORE dispatch so the event's own
				// before-input-event/focus echo can't arm the user lock.
				markAgentInput(msg.viewId);
				if (event.type === "mouseDown" || event.type === "mouseUp" || event.type === "mouseMove" || event.type === "mouseWheel") {
					showAgentCursor(wc, event.x, event.y); // fire-and-forget, never blocks input
				}
				wc.sendInputEvent(event);
				return {};
			});
			return;
		}
		case "lax:browser-capture": {
			reply(proc, "lax:browser-capture-result", msg.id, async () => {
				const pngB64 = (await requireWebContents(msg.viewId).capturePage()).toPNG().toString("base64");
				if (pngB64.length > CAPTURE_MAX_B64) throw new Error(`capture exceeds ${CAPTURE_MAX_B64} base64 bytes`);
				return { pngB64 };
			});
			return;
		}
	}
}

// Run an op and send "<type>" with { id, ok } + payload; failures become
// { ok: false, error } so a bad op can never take down the bridge listener.
function reply(
	proc: ChildProcess,
	type: string,
	id: number,
	run: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): void {
	void (async () => {
		let payload: Record<string, unknown>;
		try {
			payload = { ok: true, ...(await run()) };
		} catch (e) {
			payload = { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
		try { proc.send({ type, id, ...payload }); } catch { /* child exited */ }
	})();
}

/**
 * allFrames exec: one result per frame reachable in an ISOLATED world,
 * main frame first. Electron 35's WebFrameMain exposes only main-world
 * executeJavaScript — running agent scripts there would let page JS observe
 * or tamper with them, so same-origin subframes are enumerated but SKIPPED
 * (fail closed), never executed in the main world. Same-origin frame content
 * remains reachable today from the main frame's isolated world via
 * contentDocument traversal (how extract.ts collects iframe elements).
 * Revisit when Electron grows a WebFrameMain isolated-world API.
 */
async function execSameOriginFrames(wc: WebContents, script: string): Promise<unknown[]> {
	const results: unknown[] = [
		await wc.executeJavaScriptInIsolatedWorld(EXEC_ISOLATED_WORLD_ID, [{ code: script }]) as unknown,
	];
	const skipped = wc.mainFrame.framesInSubtree
		.filter((frame) => frame !== wc.mainFrame && sameOrigin(frame.url, wc.getURL()))
		.length;
	if (skipped > 0) {
		console.warn(
			`[browser-bridge] allFrames exec: skipped ${skipped} same-origin subframe(s) — ` +
			`no isolated-world exec on WebFrameMain in Electron 35 (fail closed, never main world)`,
		);
	}
	return results;
}

function sameOrigin(a: string, b: string): boolean {
	try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

function requireWebContents(viewId: string): WebContents {
	const view = getBrowserView(viewId);
	if (!view || view.webContents.isDestroyed()) throw new Error(`no browser view "${viewId}"`);
	return view.webContents;
}

function lifecycle(msg: BrowserLifecycleRequest): Record<string, unknown> {
	switch (msg.op) {
		case "create": {
			if (!msg.partition) throw new Error("create requires a partition");
			// Bridge-created views are always agent-driving (per-(session,profile));
			// the renderer's own foreground view is created via browser-ipc.ts.
			return { view: createBrowserView(msg.viewId, { partition: msg.partition, bounds: msg.bounds, agentDriven: true }) };
		}
		case "show":
			showBrowserView(msg.viewId);
			return {};
		case "hide":
			hideBrowserView(msg.viewId);
			return {};
		case "close":
			closeBrowserView(msg.viewId);
			return {};
		case "setBounds": {
			if (!msg.bounds) throw new Error("setBounds requires bounds");
			setBrowserViewBounds(msg.viewId, msg.bounds);
			return {};
		}
		case "ping":
			// userActive lets the server-side pre-exec arbitration (eval-driven
			// mutations bypass the input gate) see the co-drive lock.
			return { ping: { ...pingBrowserView(msg.viewId), userActive: isUserActive(msg.viewId) } };
		case "list":
			return { views: listBrowserViews() satisfies BrowserViewInfo[] };
	}
}

// Settles on main-frame success (did-finish-load, or did-stop-loading for
// pages that never fire finish), main-frame failure (did-fail-load, code -3
// "aborted" excluded — a JS redirect is not a failure), or the deadline.
function navigate(msg: BrowserNavigateRequest): Promise<Record<string, unknown>> {
	const wc = requireWebContents(msg.viewId);
	const timeoutMs = msg.timeoutMs ?? NAVIGATE_DEFAULT_TIMEOUT_MS;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (payload: Record<string, unknown>) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			wc.off("did-fail-load", onFail);
			wc.off("did-finish-load", onDone);
			wc.off("did-stop-loading", onDone);
			resolve(payload);
		};
		const onFail = (_e: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
			if (!isMainFrame || errorCode === -3) return;
			finish({ ok: false, error: `${errorDescription || `load failed (${errorCode})`} (${validatedURL})` });
		};
		const onDone = () => finish({ ok: true, url: wc.getURL(), title: wc.getTitle() });
		const deadline = setTimeout(() => {
			// Stop the still-loading page — the client has already given up,
			// and a zombie load would race the NEXT navigate's did-stop-loading.
			if (!wc.isDestroyed()) wc.stop();
			finish({ ok: false, error: `navigation did not settle within ${timeoutMs}ms` });
		}, timeoutMs);
		wc.on("did-fail-load", onFail);
		wc.on("did-finish-load", onDone);
		wc.on("did-stop-loading", onDone);
		wc.loadURL(msg.url).catch((e: unknown) => {
			finish({ ok: false, error: e instanceof Error ? e.message : String(e) });
		});
	});
}

function toElectronInputEvent(ev: BridgeInputEvent): MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent | null {
	switch (ev.type) {
		case "mouseDown":
		case "mouseUp":
		case "mouseMove":
			return { type: ev.type, x: ev.x, y: ev.y, button: ev.button, clickCount: ev.clickCount, modifiers: ev.modifiers };
		case "mouseWheel":
			return { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.deltaX, deltaY: ev.deltaY, modifiers: ev.modifiers };
		case "keyDown":
		case "keyUp":
		case "char":
			return { type: ev.type, keyCode: ev.keyCode, modifiers: ev.modifiers };
		default:
			return null;
	}
}
