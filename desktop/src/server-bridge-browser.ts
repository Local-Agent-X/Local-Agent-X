/**
 * Browser-view message family for the server↔desktop bridge.
 *
 * Dispatched from server-bridge.ts (same transport, same reply idiom:
 * "<type>-result" carrying the request id). Drives the WebContentsView
 * pool (browser-views.ts) on behalf of the server child:
 *   lifecycle / navigate / exec / input / capture / abort /
 *   read-console / read-network (browser-perception.ts rings) /
 *   dialogs (browser-dialogs.ts beforeunload queue).
 *
 * Also wires the per-partition egress guard (browser-partition.ts) to
 * the server's canonical URL policy: wireBrowserEgressEvaluator installs
 * an evaluator that IPC-asks the child ("lax:browser-egress-ask") and
 * FAILS CLOSED — no child, send failure, or a reply slower than the
 * short deadline all deny. Policy lives server-side only.
 */

import type { ChildProcess } from "child_process";
import type { KeyboardInputEvent, MouseInputEvent, MouseWheelInputEvent, WebContents } from "electron";

import {
	closeBrowserView,
	createBrowserView,
	getBrowserView,
	hideBrowserView,
	listBrowserViews,
	pingBrowserView,
	setBrowserViewBounds,
	setViewLifecycleObserver,
	showBrowserView,
	type BrowserViewInfo,
} from "./browser-views";
import { autoSurfaceAgentView } from "./browser-ipc";
import { attachDialogInterception, detachDialogState, handleDialog, listDialogs } from "./browser-dialogs";
import { wireDownloadBridge } from "./browser-downloads-bridge";
import { getHardenedPartitionSession, setEgressEvaluator } from "./browser-partition";
import { askServerEgress, settleEgressAsk } from "./server-bridge-egress";
import {
	attachViewPerception,
	detachViewPerception,
	markAgentNavigation,
	readConsoleEntries,
	readNetworkEntries,
	setBrowserUiEventSink,
} from "./browser-perception";
import { isUserActive, markAgentInput, showAgentCursor } from "./in-app-browser";
import { settleNavigation } from "./navigate-settle";

// Isolated world for agent scripts — never the main world, so page JS
// can't tamper with (or observe) what the agent executes.
const EXEC_ISOLATED_WORLD_ID = 1901;
const NAVIGATE_DEFAULT_TIMEOUT_MS = 25_000;
const CAPTURE_MAX_B64 = 2 * 1024 * 1024; // mirrors PROBE_MAX_SCREENSHOT_B64

// ── Wire types (server-bridge-browser-wire.ts; re-exported for callers) ─────────
import type {
	BridgeInputEvent,
	BrowserBridgeMessage,
	BrowserLifecycleRequest,
	BrowserNavigateRequest,
} from "./server-bridge-browser-wire";
export { isBrowserBridgeMessage } from "./server-bridge-browser-wire";
export type { BridgeInputEvent, BrowserBridgeMessage, BrowserLifecycleOp } from "./server-bridge-browser-wire";

/** Point the partition egress guard at the server child. Called from
 *  attachServerBridge on every (re)spawn so the closure always holds the
 *  live process; a dead/replaced child fails closed inside the ask. */
export function wireBrowserEgressEvaluator(proc: ChildProcess): void {
	setEgressEvaluator((req) => askServerEgress(proc, req));
	// Same (re)spawn moment arms perception (console rings + UI events) and
	// beforeunload-dialog interception on every view's lifecycle.
	setViewLifecycleObserver({
		onViewCreated: (viewId, wc, agentDriven) => {
			attachViewPerception(viewId, wc, agentDriven);
			attachDialogInterception(viewId, wc);
		},
		onViewClosed: (viewId) => {
			detachViewPerception(viewId);
			detachDialogState(viewId);
		},
	});
	setBrowserUiEventSink((msg) => {
		try {
			if (proc.connected && !proc.killed) proc.send(msg);
		} catch {
			/* child gone — UI events are best-effort by contract */
		}
	});
	// Download attribution + terminal-entry push (outbox: flushes backlog now,
	// marks entries reported only when proc.send succeeded).
	wireDownloadBridge((msg) => {
		try {
			return proc.connected && !proc.killed && proc.send(msg);
		} catch {
			return false;
		}
	});
}

// ── Dispatch ─────────
export async function handleBrowserBridgeMessage(proc: ChildProcess, msg: BrowserBridgeMessage): Promise<void> {
	switch (msg.type) {
		case "lax:browser-egress-ask-result": {
			settleEgressAsk(msg.id, msg.allowed === true);
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
		case "lax:browser-clear-partition": {
			reply(proc, "lax:browser-clear-partition-result", msg.id, () => clearPartition(msg.partition));
			return;
		}
		case "lax:browser-dialogs": {
			reply(proc, "lax:browser-dialogs-result", msg.id, () => {
				requireWebContents(msg.viewId); // typed "no browser view" on dead/unknown ids
				return msg.op === "list"
					? { dialogs: listDialogs(msg.viewId) }
					: { handled: handleDialog(msg.viewId, msg.op) };
			});
			return;
		}
		case "lax:browser-read-console": {
			reply(proc, "lax:browser-read-console-result", msg.id, () => {
				requireWebContents(msg.viewId); // typed "no browser view" on a dead/unknown id
				return { entries: readConsoleEntries(msg.viewId) };
			});
			return;
		}
		case "lax:browser-read-network": {
			reply(proc, "lax:browser-read-network-result", msg.id, () => {
				// Network capture is per-partition (session-scoped webRequest) —
				// resolve the view's partition, then read that ring.
				const info = listBrowserViews().find((v) => v.viewId === msg.viewId);
				if (!info) throw new Error(`no browser view "${msg.viewId}"`);
				return { network: readNetworkEntries(info.partition) };
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
		case "close": {
			// Bridge callers only own the views the bridge created (agentDriven).
			// The renderer's foreground/profile/user views are the USER's — a
			// server-side close of one would yank the page out from under them.
			const info = listBrowserViews().find((v) => v.viewId === msg.viewId);
			if (info && !info.agentDriven) throw new Error(`refusing to close non-agent view ${msg.viewId}`);
			closeBrowserView(msg.viewId);
			return {};
		}
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

// Settle semantics live in navigate-settle.ts (unit-tested there): full load
// settles immediately; a heavy CSR SPA that never quiesces settles shortly
// after dom-ready instead of outrunning the deadline + the server's wedge
// timer (the 2026-07-20 Thrive hang class).
function navigate(msg: BrowserNavigateRequest): Promise<Record<string, unknown>> {
	const wc = requireWebContents(msg.viewId);
	return settleNavigation(wc, msg.url, {
		timeoutMs: msg.timeoutMs ?? NAVIGATE_DEFAULT_TIMEOUT_MS,
		// agent nav, even on adopted views — not user activity
		onBeforeLoad: () => markAgentNavigation(msg.viewId),
		onSuccess: () => {
			// Successful AGENT navigate → offer the view to the renderer's anchor.
			// browser-ipc owns the policy (blank-foreground only); this path only
			// fires for bridge-owned agentDriven views.
			if (listBrowserViews().some((v) => v.viewId === msg.viewId && v.agentDriven)) {
				autoSurfaceAgentView(msg.viewId);
			}
		},
	});
}

/**
 * Wipe a profile partition's saved logins on the Electron backend. Fail-safe
 * ORDERING, all in one place so nothing races across the process boundary:
 *   1. navigate every OPEN pool view on this partition to about:blank, so a
 *      live page can't keep authenticated cookies resident in memory and
 *      re-persist them past the clear,
 *   2. THEN session.clearStorageData() flushes cookies + every storage backend
 *      (localStorage/IndexedDB/service workers/cache) for the partition.
 * The renderer/caller reloads afterward; a blanked view just shows about:blank
 * until then. Best-effort per view — a destroyed webContents is skipped.
 */
async function clearPartition(partition: string): Promise<Record<string, unknown>> {
	for (const info of listBrowserViews()) {
		if (info.partition !== partition) continue;
		const wc = getBrowserView(info.viewId)?.webContents;
		if (wc && !wc.isDestroyed()) await wc.loadURL("about:blank").catch(() => { /* keep clearing */ });
	}
	await getHardenedPartitionSession(partition).clearStorageData();
	return {};
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
