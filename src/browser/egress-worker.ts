/**
 * egress-worker — worker_thread that answers in-app browser egress asks OFF the
 * server's main event loop.
 *
 * WHY: the desktop asks the server child to approve every browser-view request
 * ("lax:browser-egress-ask"). Node parent/child IPC delivery runs on the
 * child's main event loop, which stalls for seconds during model turns
 * (measured selectTools 10.5s) — so page loads hung even though the decision
 * itself is cheap. DELIVERY was the bottleneck. This worker owns its own
 * transport (a named pipe / unix socket served on the WORKER's loop), so asks
 * are answered while the main thread is busy.
 *
 * Protocol (newline-delimited JSON over the pipe): EgressPipeAsk in →
 * EgressPipeReply out. The decision is the SAME decideEgressAsk core the
 * in-loop fallback (bridge-egress.ts answerEgressAsk) uses — evaluated here
 * against a config cache plus MIRRORED registries (taint / canaries / adopted
 * views / discovered local-runtime ports), because a worker's module instances
 * cannot see the main thread's maps. Mirrors are fed by the host
 * (egress-worker-host.ts) from the
 * registries' subscribe seams and are eventually-consistent — acceptable
 * because the taint scan is the documented fail-open defense-in-depth layer;
 * the URL policy layer stays fail-closed and reads only disk config.
 *
 * Deny/canary side effects are POSTED to the host so the recent-deny cache and
 * the CryptoAuditTrail stay single-writer on the main thread.
 *
 * Fail-closed invariants: any error answering an ask → { allowed: false };
 * malformed pipe input → that connection is destroyed, the worker survives.
 * The pipe name embeds pid + a random nonce, and named pipes / tmpdir sockets
 * are host-local by construction.
 *
 * RUNTIME SPLIT (vector-search-worker.ts precedent, evolved): under tsx/vitest
 * this file is spawned as .ts and Node cannot resolve the project's ".js"
 * specifiers back to .ts sources inside a worker. Unlike vector-search-worker
 * this worker MUST import the canonical policy modules (never duplicate
 * logic), so it registers a resolve hook mapping a failing ".js" specifier to
 * its ".ts" source, then loads project modules DYNAMICALLY (static project
 * imports would resolve before the hook exists). The host spawns it with
 * --experimental-transform-types in that mode. Compiled dist needs neither.
 */

import { parentPort, workerData, type MessagePort } from "node:worker_threads";
import { createServer, type Socket } from "node:net";
import { statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { register } from "node:module";
import type { TaintEntry } from "../data-lineage/fingerprint.js";
import type { EgressAskDeps, EgressAskMessage } from "./bridge-egress.js";
import type { EgressConfig } from "../security/layer/network-policy.js";

// ── Wire types (host + desktop pipe client import these type-only) ─────────
/** One pipe request. Same shape as the in-loop EgressAskMessage. */
export type EgressPipeAsk = EgressAskMessage;
export interface EgressPipeReply { id: number; allowed: boolean }

/** Host → worker registry deltas (subscribe-seam replays included).
 *  "runtime-ports" is a full snapshot of the discovered local-runtime loopback
 *  ports, not a delta — the host re-derives the whole set per cache change. */
export type EgressWorkerControl =
	| { kind: "taint"; sessionId: string; entries: TaintEntry[] }
	| { kind: "canaries"; sessionId: string; canaries: string[] }
	| { kind: "adopted"; viewId: string; sessionId: string | null }
	| { kind: "runtime-ports"; ports: string[] };

/** Worker → host posts (single-writer side effects stay on the main thread). */
export type EgressWorkerPost =
	| { kind: "ready"; pipeName: string }
	| { kind: "deny"; url: string; viewId: string | undefined; reason: string; recovery?: string }
	| { kind: "allow-clear"; url: string; viewId: string | undefined }
	| { kind: "canary"; sessionId: string };

export interface EgressWorkerData { role: "lax-egress-worker"; selfPort: string }

const IS_TS_RUNTIME = import.meta.url.endsWith(".ts");

/** Map a failing relative ".js" specifier onto its ".ts" source so the
 *  canonical project modules load inside a tsx-era worker (see header). */
function registerTsSourceResolution(): void {
	const hook =
		`export async function resolve(specifier, context, nextResolve) {\n` +
		`  try { return await nextResolve(specifier, context); }\n` +
		`  catch (e) {\n` +
		`    if (specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context);\n` +
		`    throw e;\n` +
		`  }\n` +
		`}\n`;
	register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);
}

function makePipeName(): string {
	// pid + 64-bit random nonce: never guessable-trivial, never colliding across
	// restarts (each respawn mints a fresh endpoint).
	const nonce = randomBytes(8).toString("hex");
	return process.platform === "win32"
		? `\\\\.\\pipe\\lax-egress-${process.pid}-${nonce}`
		: join(tmpdir(), `lax-egress-${process.pid}-${nonce}.sock`);
}

/** `mtimeMs:size` stat key ("absent" when unreadable) — cheap per-ask change
 *  detection for the config cache below. */
function statKey(path: string): string {
	try {
		const s = statSync(path);
		return `${s.mtimeMs}:${s.size}`;
	} catch {
		return "absent";
	}
}

function isPipeAsk(v: unknown): v is EgressPipeAsk {
	if (typeof v !== "object" || v === null) return false;
	const d = v as Record<string, unknown>;
	return typeof d.id === "number" && typeof d.url === "string";
}

// A single ask line is a URL + optional page body; cap it so a runaway client
// can't balloon worker memory. Oversized input destroys that connection only.
const MAX_LINE_BYTES = 8 * 1024 * 1024;

async function runEgressWorker(port: MessagePort, data: EgressWorkerData): Promise<void> {
	if (IS_TS_RUNTIME) registerTsSourceResolution();
	// Dynamic: these must resolve AFTER the .ts resolution hook is registered.
	const { loadEgressConfig, evaluateWebFetch } = await import("../security/layer/network-policy.js");
	const { getLaxDir } = await import("../lax-data-dir.js");
	const { scanPageEgressWith } = await import("./page-egress-taint.js");
	const { findTaintInEntries } = await import("../data-lineage/index.js");
	const { checkCanariesInPayloadList } = await import("../threat/canaries.js");
	const { sessionIdFromViewId } = await import("./bridge-perception.js");
	const { decideEgressAsk, denyKey } = await import("./bridge-egress.js");

	// ── Mirrored registries (fed by host deltas; eventually-consistent) ──
	const taintMirror = new Map<string, TaintEntry[]>();
	const canaryMirror = new Map<string, string[]>();
	const adoptedMirror = new Map<string, string>();
	// Discovered local-runtime loopback ports (main thread's cache.ts snapshot;
	// this thread's cache module instance is never populated). Starts empty →
	// fail-toward-deny until the host's subscribe replay lands.
	let runtimePortsMirror = new Set<string>();

	port.on("message", (msg: EgressWorkerControl) => {
		if (!msg || typeof msg !== "object") return;
		if (msg.kind === "taint") {
			if (msg.entries.length > 0) taintMirror.set(msg.sessionId, msg.entries);
			else taintMirror.delete(msg.sessionId);
		} else if (msg.kind === "canaries") {
			if (msg.canaries.length > 0) canaryMirror.set(msg.sessionId, msg.canaries);
			else canaryMirror.delete(msg.sessionId);
		} else if (msg.kind === "adopted") {
			if (msg.sessionId !== null) adoptedMirror.set(msg.viewId, msg.sessionId);
			else adoptedMirror.delete(msg.viewId);
		} else if (msg.kind === "runtime-ports") {
			runtimePortsMirror = new Set(msg.ports);
		}
	});

	// ── Egress-config cache: reload only when the on-disk policy changed ──
	// (a stat per ask instead of a full read+parse — the whole point of the
	// worker is cheap per-request work).
	let cfgCache: { key: string; cfg: EgressConfig } | null = null;
	function currentConfig(): EgressConfig {
		const dir = getLaxDir();
		// Every file loadEgressConfig folds in keys the cache: the allowlist +
		// security.json, PLUS config.json (ollamaLoopbackPort) and settings.json
		// (manual runtime entries) — so an ollama/manual port change propagates
		// without an unrelated policy-file touch.
		const key = [
			statKey(join(dir, "egress-allowlist.json")),
			statKey(join(dir, "security.json")),
			statKey(join(dir, "config.json")),
			statKey(join(dir, "settings.json")),
		].join("|");
		if (cfgCache === null || cfgCache.key !== key) cfgCache = { key, cfg: loadEgressConfig() };
		return cfgCache.cfg;
	}

	// The same decision core as the in-loop fallback, bound to the cached
	// config and the mirrors instead of the main thread's module state.
	const deps: EgressAskDeps = {
		evaluateUrl: (url) => {
			const cfg = currentConfig();
			// Fold the mirrored discovered-runtime ports into localServicePorts
			// exactly as loadEgressConfig folds the cache-derived ports in-loop
			// (localRuntimeLoopbackPorts reads a cache THIS thread never fills).
			// Union per ask, never mutating the cached set.
			const localPorts = runtimePortsMirror.size === 0
				? cfg.localServicePorts
				: new Set([...cfg.localServicePorts, ...runtimePortsMirror]);
			return evaluateWebFetch(cfg.allowlist, cfg.configured, data.selfPort, url, cfg.mode, localPorts, cfg.manualHostPorts);
		},
		sessionForView: (viewId) => sessionIdFromViewId(viewId) ?? adoptedMirror.get(viewId),
		scan: (sessionId, req) =>
			scanPageEgressWith(
				{
					findTaintInPayload: (sid, payload) => findTaintInEntries(taintMirror.get(sid) ?? [], payload),
					checkCanariesInPayload: (sid, payload) => checkCanariesInPayloadList(canaryMirror.get(sid) ?? [], payload),
				},
				sessionId,
				req,
			),
	};

	// Which deny keys THIS worker put in the host's recent-deny cache — lets a
	// later re-allow post a targeted clear (mirroring the in-loop path's
	// clear-on-allow) without posting on every allowed request. Bounded.
	const postedDenyKeys = new Set<string>();
	const POSTED_DENY_MAX = 256;

	function handleAsk(socket: Socket, ask: EgressPipeAsk): void {
		let allowed = false;
		try {
			const outcome = decideEgressAsk(ask, deps);
			allowed = outcome.allowed;
			const key = denyKey(ask.url, ask.viewId);
			if (outcome.deny) {
				if (!postedDenyKeys.has(key) && postedDenyKeys.size >= POSTED_DENY_MAX) {
					const oldest = postedDenyKeys.values().next().value;
					if (oldest !== undefined) postedDenyKeys.delete(oldest);
				}
				postedDenyKeys.add(key);
				port.postMessage({ kind: "deny", url: ask.url, viewId: ask.viewId, reason: outcome.deny.reason, recovery: outcome.deny.recovery } satisfies EgressWorkerPost);
			} else if (allowed && postedDenyKeys.delete(key)) {
				port.postMessage({ kind: "allow-clear", url: ask.url, viewId: ask.viewId } satisfies EgressWorkerPost);
			}
			if (outcome.canarySessionId) {
				port.postMessage({ kind: "canary", sessionId: outcome.canarySessionId } satisfies EgressWorkerPost);
			}
		} catch {
			allowed = false; // any error answering → deny (fail-closed)
		}
		try {
			socket.write(JSON.stringify({ id: ask.id, allowed } satisfies EgressPipeReply) + "\n");
		} catch {
			// Peer gone mid-reply — its deadline handles it; nothing to do here.
		}
	}

	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		let buf = "";
		socket.on("data", (chunk: string) => {
			buf += chunk;
			if (buf.length > MAX_LINE_BYTES) {
				socket.destroy();
				return;
			}
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.trim() === "") continue;
				let ask: unknown;
				try {
					ask = JSON.parse(line);
				} catch {
					socket.destroy(); // malformed input: drop the connection, keep the worker
					return;
				}
				if (!isPipeAsk(ask)) {
					socket.destroy();
					return;
				}
				handleAsk(socket, ask);
			}
		});
		socket.on("error", () => socket.destroy());
	});

	const pipeName = makePipeName();
	server.on("error", (e) => {
		// Can't serve asks without a listener — exit so the host respawns us on
		// a fresh endpoint (its bounded-backoff restart path).
		console.error(`[egress-worker] pipe server error: ${e.message}`);
		process.exit(1);
	});
	server.listen(pipeName, () => {
		port.postMessage({ kind: "ready", pipeName } satisfies EgressWorkerPost);
	});
}

function isEgressWorkerData(d: unknown): d is EgressWorkerData {
	return typeof d === "object" && d !== null
		&& (d as Record<string, unknown>).role === "lax-egress-worker"
		&& typeof (d as Record<string, unknown>).selfPort === "string";
}

// Bootstrap. The workerData shape check matters: this module is also imported
// by the host (for the wire types) and under vitest's pool the "main thread"
// can itself be a worker with a live parentPort — only OUR spawn may serve.
if (parentPort && isEgressWorkerData(workerData)) {
	runEgressWorker(parentPort, workerData).catch((e) => {
		console.error(`[egress-worker] fatal: ${(e as Error).message}`);
		process.exit(1);
	});
}
