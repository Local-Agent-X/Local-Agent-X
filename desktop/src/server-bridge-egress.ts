/**
 * server-bridge-egress — the desktop→server per-hop egress ASK client.
 *
 * The partition egress guard (browser-partition.ts) is fail-closed and delegates
 * each in-app browser request to the server child. This owns the
 * request/deadline/correlation machinery over TWO transports with ONE
 * settlement core:
 *
 *   1. PIPE (preferred): the server's off-loop egress worker
 *      (src/browser/egress-worker.ts) serves a nonce-named pipe announced via
 *      "lax:browser-egress-endpoint" on every worker (re)boot. Asks over the
 *      pipe are answered in milliseconds even while the server's main event
 *      loop is blocked inside a model turn.
 *   2. IPC (fallback): the original "lax:browser-egress-ask" proc.send path,
 *      answered on the server's main loop. Used until an endpoint is announced,
 *      whenever the pipe is down, and per-request when a pipe write fails or
 *      the connection dies mid-flight (those asks re-route to IPC).
 *
 * Fail-closed invariants: every ask settles on its reply or the SAME deadline
 * regardless of transport; a pipe connection error denies nothing by itself
 * (in-flight asks re-route to IPC and the per-ask deadline owns final
 * settlement); a reply for an unknown/expired id is ignored; pending pipe asks
 * are bounded — overflow goes straight to IPC. Split out of
 * server-bridge-browser.ts to keep that file within the size budget; IPC
 * replies are routed back here by the bridge dispatcher.
 */

import type { ChildProcess } from "child_process";
import { connect, type Socket } from "net";

import { viewIdForWebContents } from "./browser-views";
import type { EgressDecision, EgressRequest } from "./browser-partition";

/**
 * Per-hop policy ask deadline; fail closed past it. Sized to tolerate the
 * server's REAL event-loop stalls, not an idealized round-trip: during agent
 * turns the child blocks for seconds at a time (measured 2026-07-20:
 * selectTools 10.5s, buildSystemPrompt 0.7s), and at the old 250ms every
 * in-app request timing out → denied rendered the whole browser as
 * ERR_BLOCKED_BY_CLIENT / "You're offline" exactly while the agent was
 * thinking. Chromium happily holds a webRequest callback this long — a slow
 * page beats a spuriously offline one. A DEAD child never waits this out:
 * proc.connected/send-failure deny immediately above. The pipe path normally
 * settles in milliseconds; this stays the OUTER bound for both transports.
 */
const EGRESS_ASK_DEADLINE_MS = 15_000;

/** Rate-limited timeout-deny telemetry — one line per window, with a count,
 *  so a stalled server is diagnosable from the desktop log instead of
 *  looking like a site outage. Applies to both transports (the deadline is
 *  transport-independent). */
const TIMEOUT_LOG_WINDOW_MS = 10_000;
let timeoutDenies = 0;
let timeoutWindowStart = 0;

function noteTimeoutDeny(url: string): void {
	const now = Date.now();
	timeoutDenies++;
	if (now - timeoutWindowStart < TIMEOUT_LOG_WINDOW_MS) return;
	console.warn(
		`[server-bridge-egress] ${timeoutDenies} egress ask(s) DENIED on the ${EGRESS_ASK_DEADLINE_MS}ms deadline ` +
		`(server event loop stalled?) — latest: ${url.slice(0, 120)}`,
	);
	timeoutWindowStart = now;
	timeoutDenies = 0;
}

let egressSeq = 0;
const pendingEgressAsks = new Map<number, (allowed: boolean) => void>();

// ── Off-loop pipe transport ─────────

const PIPE_RECONNECT_INITIAL_MS = 250;
const PIPE_RECONNECT_MAX_MS = 5_000;
/** Bounded in-flight buffer: asks past this cap use IPC for that request —
 *  the pipe client never queues unbounded. Exported for the overflow test. */
export const PIPE_INFLIGHT_MAX = 256;
/** Replies are tiny JSON lines; a peer streaming more than this without a
 *  newline is violating the protocol → drop the connection. */
const PIPE_MAX_BUFFER_BYTES = 64 * 1024;

interface PipeInflightAsk { proc: ChildProcess; ask: Record<string, unknown> }

let pipeEndpoint: string | null = null;
let pipeSocket: Socket | null = null;
let pipeConnected = false;
let pipeBuf = "";
// Bumped on every connect/drop so events from a superseded socket are inert.
let pipeEpoch = 0;
let pipeReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pipeBackoffMs = PIPE_RECONNECT_INITIAL_MS;
// Asks currently awaiting a pipe reply, kept with their original wire message
// so a dying connection can re-route them to the IPC path.
const pipeInflight = new Map<number, PipeInflightAsk>();

/** Adopt a (re-)announced worker pipe endpoint: drop any current connection
 *  (each worker spawn mints a fresh nonce name) and connect to the new one. */
export function setEgressPipeEndpoint(pipeName: string): void {
	dropPipeConnection();
	pipeEndpoint = pipeName;
	pipeBackoffMs = PIPE_RECONNECT_INITIAL_MS;
	connectPipe();
	console.log(`[server-bridge-egress] egress pipe endpoint announced: ${pipeName}`);
}

/** Forget the pipe entirely (server child respawn — the old child's worker
 *  died with it). Asks revert to the IPC path until the NEW child announces a
 *  fresh endpoint. */
export function resetEgressPipe(): void {
	pipeEndpoint = null;
	dropPipeConnection();
}

/** Test-only visibility into the pipe transport state. */
export function _egressPipeStateForTest(): { endpoint: string | null; connected: boolean; inflight: number } {
	return { endpoint: pipeEndpoint, connected: pipeConnected, inflight: pipeInflight.size };
}

/** Tear down the socket (idempotent) and re-route its in-flight asks to IPC.
 *  Never settles an ask by itself — connection errors deny nothing; the
 *  re-routed IPC ask or the per-ask deadline owns settlement. */
function dropPipeConnection(): void {
	pipeEpoch++; // stale-ify any pending events from the old socket
	if (pipeReconnectTimer !== null) {
		clearTimeout(pipeReconnectTimer);
		pipeReconnectTimer = null;
	}
	const socket = pipeSocket;
	pipeSocket = null;
	pipeConnected = false;
	pipeBuf = "";
	socket?.destroy();
	drainPipeInflightToIpc();
}

function connectPipe(): void {
	if (pipeEndpoint === null || pipeSocket !== null) return;
	const epoch = ++pipeEpoch;
	let socket: Socket;
	try {
		socket = connect(pipeEndpoint);
	} catch {
		schedulePipeReconnect(); // IPC keeps serving in the meantime
		return;
	}
	pipeSocket = socket;
	pipeBuf = "";
	socket.setEncoding("utf8");
	socket.on("connect", () => {
		if (epoch !== pipeEpoch) return;
		pipeConnected = true;
		pipeBackoffMs = PIPE_RECONNECT_INITIAL_MS;
	});
	socket.on("data", (chunk: string) => {
		if (epoch !== pipeEpoch) return;
		onPipeData(chunk);
	});
	// "close" always follows "error" — one recovery path, and a connection
	// error by itself never denies (see dropPipeConnection).
	socket.on("error", () => { /* handled via close */ });
	socket.on("close", () => {
		if (epoch !== pipeEpoch) return;
		dropPipeConnection();
		schedulePipeReconnect();
	});
}

function schedulePipeReconnect(): void {
	if (pipeEndpoint === null || pipeReconnectTimer !== null) return;
	pipeReconnectTimer = setTimeout(() => {
		pipeReconnectTimer = null;
		connectPipe();
	}, pipeBackoffMs);
	pipeReconnectTimer.unref?.();
	pipeBackoffMs = Math.min(pipeBackoffMs * 2, PIPE_RECONNECT_MAX_MS);
}

function isPipeReply(v: unknown): v is { id: number; allowed: boolean } {
	if (typeof v !== "object" || v === null) return false;
	const d = v as Record<string, unknown>;
	return typeof d.id === "number" && typeof d.allowed === "boolean";
}

function onPipeData(chunk: string): void {
	pipeBuf += chunk;
	if (pipeBuf.length > PIPE_MAX_BUFFER_BYTES) {
		dropPipeAndReconnect("oversized reply buffer");
		return;
	}
	let nl: number;
	while ((nl = pipeBuf.indexOf("\n")) >= 0) {
		const line = pipeBuf.slice(0, nl);
		pipeBuf = pipeBuf.slice(nl + 1);
		if (line.trim() === "") continue;
		let reply: unknown;
		try {
			reply = JSON.parse(line);
		} catch {
			dropPipeAndReconnect("malformed reply");
			return;
		}
		if (!isPipeReply(reply)) {
			dropPipeAndReconnect("malformed reply");
			return;
		}
		const entry = pipeInflight.get(reply.id);
		if (!entry) continue; // unknown/expired id → ignore by contract
		pipeInflight.delete(reply.id);
		pendingEgressAsks.get(reply.id)?.(reply.allowed);
	}
}

/** A protocol violation poisons the whole connection (framing is lost):
 *  drop it — in-flight asks re-route to IPC — and retry with backoff. */
function dropPipeAndReconnect(why: string): void {
	console.warn(`[server-bridge-egress] egress pipe dropped (${why}) — in-flight asks fall back to IPC`);
	dropPipeConnection();
	schedulePipeReconnect();
}

function drainPipeInflightToIpc(): void {
	if (pipeInflight.size === 0) return;
	const entries = [...pipeInflight.entries()];
	pipeInflight.clear();
	for (const [id, { proc, ask }] of entries) {
		// Skip asks the deadline already settled; the rest keep their id, so
		// the eventual IPC reply lands in the same pending resolver.
		if (pendingEgressAsks.has(id)) sendAskOverIpc(proc, id, ask);
	}
}

/** Try the pipe. False = not connected / at the in-flight cap / write threw —
 *  the caller sends THIS ask over IPC instead (behavior identical to today). */
function sendAskOverPipe(proc: ChildProcess, id: number, ask: Record<string, unknown>): boolean {
	if (!pipeConnected || pipeSocket === null) return false;
	if (pipeInflight.size >= PIPE_INFLIGHT_MAX) return false; // bounded buffer → IPC
	pipeInflight.set(id, { proc, ask });
	try {
		pipeSocket.write(JSON.stringify(ask) + "\n");
		return true;
	} catch {
		// Socket died between the connected check and the write; the close
		// handler owns the connection — this ask just takes the IPC path.
		pipeInflight.delete(id);
		return false;
	}
}

function sendAskOverIpc(proc: ChildProcess, id: number, ask: Record<string, unknown>): void {
	const finish = (allowed: boolean): void => pendingEgressAsks.get(id)?.(allowed);
	try {
		// A false return means the IPC backlog crossed its threshold, not that
		// delivery failed. The message is still queued; only the callback error
		// proves a send failure. Otherwise the reply/deadline owns settlement.
		proc.send({ type: "lax:browser-egress-ask", ...ask }, (error) => {
			if (error) finish(false);
		});
	} catch {
		finish(false); // channel just closed — deny
	}
}

/** Ask the server child to decide one request — over the worker pipe when
 *  connected, else over IPC. Resolves { allowed: false } if the child is gone,
 *  the send fails on both transports, or no reply beats the deadline. */
export function askServerEgress(proc: ChildProcess, req: EgressRequest): Promise<EgressDecision> {
	if (!proc.connected || proc.killed) return Promise.resolve({ allowed: false });
	const id = ++egressSeq;
	// Resolve the owning pool viewId HERE — the view pool is a desktop concept — so
	// the server can attribute the request to its session for the taint scan. The
	// wire carries only the URL policy input + the taint-scan context (method/
	// pageUrl/body/viewId), each sent only when present. Same shape on both
	// transports: the pipe takes it as-is, IPC adds the `type` tag.
	const viewId = typeof req.webContentsId === "number" ? viewIdForWebContents(req.webContentsId) : null;
	return new Promise<EgressDecision>((resolve) => {
		let timer: ReturnType<typeof setTimeout>;
		const finish = (allowed: boolean) => {
			clearTimeout(timer);
			pendingEgressAsks.delete(id);
			pipeInflight.delete(id);
			resolve({ allowed });
		};
		pendingEgressAsks.set(id, finish);
		timer = setTimeout(() => { noteTimeoutDeny(req.url); finish(false); }, EGRESS_ASK_DEADLINE_MS);
		const ask: Record<string, unknown> = { id, url: req.url };
		if (req.method) ask.method = req.method;
		if (req.pageUrl) ask.pageUrl = req.pageUrl;
		if (req.body) ask.body = req.body;
		if (viewId) ask.viewId = viewId;
		if (!sendAskOverPipe(proc, id, ask)) sendAskOverIpc(proc, id, ask);
	});
}

/** Settle a pending ask from the server's "lax:browser-egress-ask-result" reply
 *  (routed here by the bridge dispatcher). No-op for an unknown/expired id. */
export function settleEgressAsk(id: number, allowed: boolean): void {
	pendingEgressAsks.get(id)?.(allowed);
}
