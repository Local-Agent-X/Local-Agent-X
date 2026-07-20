/**
 * server-bridge-egress — the desktop→server per-hop egress ASK client.
 *
 * The partition egress guard (browser-partition.ts) is fail-closed and delegates
 * each in-app browser request to the server child via "lax:browser-egress-ask".
 * This owns the request/deadline/correlation machinery: mint a seq id, send the
 * ask + its taint-scan context, and settle on the reply or a short deadline
 * (fail-closed past it). Split out of server-bridge-browser.ts to keep that file
 * within the size budget; the reply is routed back here by the bridge dispatcher.
 */

import type { ChildProcess } from "child_process";

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
 * proc.connected/send-failure deny immediately above.
 */
const EGRESS_ASK_DEADLINE_MS = 15_000;

/** Rate-limited timeout-deny telemetry — one line per window, with a count,
 *  so a stalled server is diagnosable from the desktop log instead of
 *  looking like a site outage. */
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

/** Ask the server child to decide one request. Resolves { allowed:false } if the
 *  child is gone, the send fails, or the reply is slower than the deadline. */
export function askServerEgress(proc: ChildProcess, req: EgressRequest): Promise<EgressDecision> {
	if (!proc.connected || proc.killed) return Promise.resolve({ allowed: false });
	const id = ++egressSeq;
	// Resolve the owning pool viewId HERE — the view pool is a desktop concept — so
	// the server can attribute the request to its session for the taint scan. The
	// wire carries only the URL policy input + the taint-scan context (method/
	// pageUrl/body/viewId), each sent only when present.
	const viewId = typeof req.webContentsId === "number" ? viewIdForWebContents(req.webContentsId) : null;
	return new Promise<EgressDecision>((resolve) => {
		let timer: ReturnType<typeof setTimeout>;
		const finish = (allowed: boolean) => { clearTimeout(timer); pendingEgressAsks.delete(id); resolve({ allowed }); };
		pendingEgressAsks.set(id, finish);
		timer = setTimeout(() => { noteTimeoutDeny(req.url); finish(false); }, EGRESS_ASK_DEADLINE_MS);
		try {
			const msg: Record<string, unknown> = { type: "lax:browser-egress-ask", id, url: req.url };
			if (req.method) msg.method = req.method;
			if (req.pageUrl) msg.pageUrl = req.pageUrl;
			if (req.body) msg.body = req.body;
			if (viewId) msg.viewId = viewId;
			// A false return means the IPC backlog crossed its threshold, not that
			// delivery failed. The message is still queued; only the callback error
			// proves a send failure. Otherwise the reply/deadline owns settlement.
			proc.send(msg, (error) => {
				if (error) finish(false);
			});
		} catch {
			finish(false); // channel just closed — deny
		}
	});
}

/** Settle a pending ask from the server's "lax:browser-egress-ask-result" reply
 *  (routed here by the bridge dispatcher). No-op for an unknown/expired id. */
export function settleEgressAsk(id: number, allowed: boolean): void {
	pendingEgressAsks.get(id)?.(allowed);
}
