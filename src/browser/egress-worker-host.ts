/**
 * egress-worker-host — main-thread owner of the off-loop egress worker
 * (egress-worker.ts; see its header for why it exists).
 *
 * Responsibilities:
 *   - spawn the worker (tsx/dist execArgv split per the vector-search
 *     workerSpawnSpec precedent, adapted: this worker imports project modules,
 *     so the ts runtime spawns with --experimental-transform-types and the
 *     worker registers its own .ts resolution hook),
 *   - feed it registry deltas from the three subscribe seams (taint, canaries,
 *     adopted views) — each seam replays full current state on subscribe, so a
 *     restarted worker's mirrors start complete,
 *   - apply its deny/canary posts through the existing single-writer paths
 *     (recordEgressDeny / clearEgressDeny / recordCanaryExfilAudit),
 *   - restart it on crash with bounded backoff, announcing each new endpoint
 *     through the onEndpoint callback (the pipe name changes every spawn).
 *
 * The in-loop "lax:browser-egress-ask" fallback in bridge-client.ts stays
 * fully functional — the desktop keeps using it until it connects to the pipe,
 * and falls back to it whenever the worker is down.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";
import { getRuntimeConfig } from "../config.js";
import { subscribeTaintChanges } from "../data-lineage/index.js";
import { recordCanaryExfilAudit, subscribeCanaryChanges } from "../threat/canaries.js";
import { subscribeAdoptedViewChanges } from "./bridge-perception.js";
import { clearEgressDeny, recordEgressDeny } from "./bridge-egress.js";
import type { EgressWorkerControl, EgressWorkerData, EgressWorkerPost } from "./egress-worker.js";

const logger = createLogger("browser-bridge");

// Under tsx/vitest this module's URL ends in .ts and the worker source runs
// via Node's type transform; the compiled dist tree spawns the plain .js file.
const IS_TS_RUNTIME = import.meta.url.endsWith(".ts");

function workerSpawnSpec(): { path: string; execArgv: string[] | undefined } {
	const workerUrl = new URL(IS_TS_RUNTIME ? "./egress-worker.ts" : "./egress-worker.js", import.meta.url);
	return {
		path: fileURLToPath(workerUrl),
		execArgv: IS_TS_RUNTIME ? ["--experimental-transform-types"] : undefined,
	};
}

const BACKOFF_INITIAL_MS = 250;
const BACKOFF_MAX_MS = 10_000;

interface HostState {
	worker: Worker | null;
	endpoint: string | null;
	unsubscribes: Array<() => void>;
	restartTimer: ReturnType<typeof setTimeout> | null;
	backoffMs: number;
	stopped: boolean;
	onEndpoint: (pipeName: string) => void;
}

let state: HostState | null = null;

/** The live pipe endpoint, or null while the worker is down/starting. */
export function currentEgressEndpoint(): string | null {
	return state?.endpoint ?? null;
}

/**
 * Start the host (idempotent). `onEndpoint` fires on every successful worker
 * boot with that spawn's pipe name — including after a crash restart, when the
 * name is NEW and must be re-announced to the desktop.
 */
export function startEgressWorkerHost(onEndpoint: (pipeName: string) => void): void {
	if (state) return;
	state = {
		worker: null,
		endpoint: null,
		unsubscribes: [],
		restartTimer: null,
		backoffMs: BACKOFF_INITIAL_MS,
		stopped: false,
		onEndpoint,
	};
	spawnWorker(state);
}

/** Stop the host and terminate the worker (shutdown / test teardown). */
export async function stopEgressWorkerHost(): Promise<void> {
	const st = state;
	if (!st) return;
	st.stopped = true;
	if (st.restartTimer !== null) clearTimeout(st.restartTimer);
	detach(st);
	const worker = st.worker;
	st.worker = null;
	state = null;
	if (worker) await worker.terminate();
}

/** Simulate a worker crash (tests): terminate WITHOUT stopping the host, so
 *  the production exit-handler restart path runs. */
export async function _crashEgressWorkerForTest(): Promise<void> {
	await state?.worker?.terminate();
}

function detach(st: HostState): void {
	for (const unsub of st.unsubscribes) unsub();
	st.unsubscribes = [];
	st.endpoint = null;
}

function spawnWorker(st: HostState): void {
	const { path, execArgv } = workerSpawnSpec();
	const workerData: EgressWorkerData = {
		role: "lax-egress-worker",
		selfPort: process.env.LAX_PORT ?? String(getRuntimeConfig().port),
	};
	const worker = new Worker(path, { workerData, execArgv });
	// Never hold the server process open on shutdown; posts still wake us.
	worker.unref();
	st.worker = worker;

	const post = (msg: EgressWorkerControl): void => {
		try {
			worker.postMessage(msg);
		} catch (e) {
			// Worker died mid-post; the exit handler owns recovery.
			logger.warn(`[egress-worker-host] mirror post failed: ${(e as Error).message}`);
		}
	};
	// Each seam replays full current state synchronously on subscribe, then
	// streams every mutation — the worker's mirrors are complete from boot.
	st.unsubscribes = [
		subscribeTaintChanges((sessionId, entries) => post({ kind: "taint", sessionId, entries: [...entries] })),
		subscribeCanaryChanges((sessionId, canaries) => post({ kind: "canaries", sessionId, canaries: [...canaries] })),
		subscribeAdoptedViewChanges((viewId, sessionId) => post({ kind: "adopted", viewId, sessionId })),
	];

	worker.on("message", (msg: EgressWorkerPost) => {
		if (!msg || typeof msg !== "object") return;
		if (msg.kind === "ready") {
			st.endpoint = msg.pipeName;
			st.backoffMs = BACKOFF_INITIAL_MS; // healthy boot resets the backoff
			logger.info(`[egress-worker-host] egress worker ready on ${msg.pipeName}`);
			st.onEndpoint(msg.pipeName);
		} else if (msg.kind === "deny") {
			recordEgressDeny(msg.url, msg.viewId, msg.reason, msg.recovery);
		} else if (msg.kind === "allow-clear") {
			clearEgressDeny(msg.url, msg.viewId);
		} else if (msg.kind === "canary") {
			recordCanaryExfilAudit(msg.sessionId, "browser-page-egress");
		}
	});
	worker.on("error", (e) => {
		logger.warn(`[egress-worker-host] egress worker error: ${e.message}`);
	});
	worker.on("exit", (code) => {
		detach(st);
		st.worker = null;
		if (st.stopped) return;
		// Crash restart, bounded backoff. The desktop falls back to the in-loop
		// ask path while we're down; onEndpoint re-announces the NEW pipe.
		logger.warn(`[egress-worker-host] egress worker exited (code ${code}); restarting in ${st.backoffMs}ms`);
		st.restartTimer = setTimeout(() => {
			st.restartTimer = null;
			if (!st.stopped) spawnWorker(st);
		}, st.backoffMs);
		st.restartTimer.unref();
		st.backoffMs = Math.min(st.backoffMs * 2, BACKOFF_MAX_MS);
	});
}
