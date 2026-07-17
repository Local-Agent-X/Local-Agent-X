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

const EGRESS_ASK_DEADLINE_MS = 250; // per-hop policy ask; fail closed past this

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
		timer = setTimeout(() => finish(false), EGRESS_ASK_DEADLINE_MS);
		try {
			const msg: Record<string, unknown> = { type: "lax:browser-egress-ask", id, url: req.url };
			if (req.method) msg.method = req.method;
			if (req.pageUrl) msg.pageUrl = req.pageUrl;
			if (req.body) msg.body = req.body;
			if (viewId) msg.viewId = viewId;
			if (!proc.send(msg)) finish(false);
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
