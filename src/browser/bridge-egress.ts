/**
 * bridge-egress — the SERVER side of the desktop→server egress ask.
 *
 * The desktop partition (desktop/src/browser-partition.ts) fails closed per-hop
 * and asks this process to decide each in-app browser request. Two layers, in
 * order: (1) the canonical URL/SSRF policy (evaluateEgressForUrl) — fail-closed,
 * authoritative; (2) a taint-aware page-egress scan (page-egress-taint.ts) —
 * defense-in-depth that blocks a cross-registrable-domain request actually
 * carrying the session's tainted/canary bytes. Split out of bridge-client.ts so
 * the op-request client and the reverse egress answerer stay separately sized
 * and testable.
 */

import { createLogger } from "../logger.js";
import { evaluateEgressForUrl } from "../security/layer/index.js";
import { getRuntimeConfig } from "../config.js";
import { recordCanaryExfilAudit } from "../threat/canaries.js";
import { scanPageEgress } from "./page-egress-taint.js";
import { adoptedViewSession, sessionIdFromViewId } from "./bridge-perception.js";

const logger = createLogger("browser-bridge");

// ── Deny-reason cache ──
//
// The ask reply to the desktop is a bare boolean, so a denied request renders
// in the view as ERR_BLOCKED_BY_CLIENT — and the agent's navigate tool used to
// surface exactly that string, with the policy's actual reason and recovery
// path visible only in the server log. The reason is computed HERE, in the
// same process that later assembles the navigate error, so a small recent-deny
// cache (keyed by origin+path — the request URL can gain a trailing slash or a
// local-auth token query en route) lets the tool layer name the real cause.
interface RecordedDeny {
	reason: string;
	recovery?: string;
	at: number;
}

const recentDenies = new Map<string, RecordedDeny>();
const DENY_TTL_MS = 30_000;
const DENY_MAX = 64;

function denyKey(url: string): string {
	try {
		const u = new URL(url);
		return u.origin + u.pathname;
	} catch {
		return url;
	}
}

function recordEgressDeny(url: string, reason: string, recovery?: string): void {
	if (recentDenies.size >= DENY_MAX) {
		const oldest = recentDenies.keys().next().value;
		if (oldest !== undefined) recentDenies.delete(oldest);
	}
	recentDenies.set(denyKey(url), { reason, recovery, at: Date.now() });
}

/** The recorded policy deny for a URL, if one happened recently. */
export function recentEgressDeny(url: string): { reason: string; recovery?: string } | null {
	const hit = recentDenies.get(denyKey(url));
	if (!hit) return null;
	if (Date.now() - hit.at > DENY_TTL_MS) {
		recentDenies.delete(denyKey(url));
		return null;
	}
	return { reason: hit.reason, recovery: hit.recovery };
}

/** Rewrap a navigate/newTab failure whose Chromium symptom
 *  (ERR_BLOCKED_BY_CLIENT) was caused by a recorded egress-policy deny, so the
 *  agent sees the policy's reason and recovery path instead of the bare
 *  network-stack error. Any other failure passes through untouched. */
export function enrichBlockedNavigation(e: unknown, url: string): unknown {
	const message = e instanceof Error ? e.message : String(e);
	if (!message.includes("ERR_BLOCKED_BY_CLIENT")) return e;
	const deny = recentEgressDeny(url);
	if (!deny) return e;
	return new Error(
		`Navigation to ${url} was blocked by the egress policy: ${deny.reason}` +
		(deny.recovery ? `\nRecovery: ${deny.recovery}` : ""),
	);
}

/** The desktop→server egress ask. `url` + `id` are required; the rest feed the
 *  taint-aware page-egress scan (absent on old/degraded senders → URL policy
 *  only, exactly the prior behavior). */
export interface EgressAskMessage {
	id: number;
	url: string;
	method?: string;
	pageUrl?: string;
	body?: string;
	viewId?: string;
}

/** Answer the desktop egress guard from the canonical URL policy PLUS the
 *  taint-aware page-egress scan. The URL policy is fail-closed on both ends; the
 *  taint scan is defense-in-depth layered on top of an allow. */
export function answerEgressAsk(ask: EgressAskMessage): void {
	let allowed = false;
	try {
		const selfPort = process.env.LAX_PORT ?? String(getRuntimeConfig().port);
		const decision = evaluateEgressForUrl(ask.url, selfPort);
		allowed = decision.allowed === true;
		// A silent deny here renders in the browser as ERR_BLOCKED_BY_CLIENT with
		// ZERO server-side trace — undiagnosable (2026-07-20). Name the reason.
		if (!allowed) {
			logger.warn(`[browser-bridge] egress DENY ${ask.url.slice(0, 120)}: ${decision.reason ?? "policy"}`);
			recordEgressDeny(ask.url, decision.reason ?? "blocked by the egress policy", decision.recovery ?? decision.userHint);
		}
		if (allowed) allowed = passesPageEgressTaint(ask);
	} catch (e) {
		logger.warn(`[browser-bridge] egress evaluation failed for ${ask.url}: ${(e as Error).message}`);
		allowed = false;
	}
	try {
		process.send!({ type: "lax:browser-egress-ask-result", id: ask.id, allowed });
	} catch (e) {
		logger.warn(`[browser-bridge] egress-ask reply send failed: ${(e as Error).message}`);
	}
}

/**
 * Taint-aware page-egress scan (defense-in-depth over the URL SSRF policy) for
 * the in-app browser page's OWN requests. Runs only for views we can attribute
 * to a session (agent-driven viewId, or an adopted user tab); an unattributable
 * view keeps URL-policy-only behavior. FAILS OPEN on a scan error: the URL policy
 * already passed fail-closed, and a bug in the payload scan must not brick all
 * in-app browsing (the reverted same-site CSP's exact failure mode). true = allow.
 */
export function passesPageEgressTaint(ask: EgressAskMessage): boolean {
	const sessionId = typeof ask.viewId === "string" && ask.viewId
		? (sessionIdFromViewId(ask.viewId) ?? adoptedViewSession(ask.viewId))
		: undefined;
	if (!sessionId) return true; // unattributable view → URL policy only.
	try {
		const verdict = scanPageEgress(sessionId, { url: ask.url, pageUrl: ask.pageUrl, body: ask.body });
		if (verdict.allowed) return true;
		// Canary is definitive exfil: record the tamper-evident audit exactly once
		// (the scan is pure; the enforcing caller owns the side effect).
		if (verdict.canary) recordCanaryExfilAudit(sessionId, "browser-page-egress");
		logger.warn(`[browser-bridge] page egress BLOCKED [${verdict.layer}] session=${sessionId}: ${verdict.reason}`);
		recordEgressDeny(ask.url, verdict.reason ?? "blocked by the page-egress taint scan");
		return false;
	} catch (e) {
		logger.warn(`[browser-bridge] page-egress taint scan errored (allowing — URL policy already passed): ${(e as Error).message}`);
		return true;
	}
}
