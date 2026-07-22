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
import { scanPageEgress, type PageEgressRequest, type PageEgressVerdict } from "./page-egress-taint.js";
import { adoptedViewSession, sessionIdFromViewId } from "./bridge-perception.js";
import type { SecurityDecision } from "../types.js";

const logger = createLogger("browser-bridge");

// ── Deny-reason cache ──
//
// The ask reply to the desktop is a bare boolean, so a denied request renders
// in the view as ERR_BLOCKED_BY_CLIENT — and the agent's navigate tool used to
// surface exactly that string, with the policy's actual reason and recovery
// path visible only in the server log. The reason is computed HERE, in the
// same process that later assembles the navigate error, so a small recent-deny
// cache (keyed by exact view + normalized origin/path; unattributed legacy asks
// use a separate null scope) lets the tool layer name the real cause without
// leaking it across views when the URL gains a slash or local-auth query.
interface RecordedDeny {
	reason: string;
	recovery?: string;
	at: number;
}

const recentDenies = new Map<string, RecordedDeny>();
const DENY_TTL_MS = 30_000;
const DENY_MAX = 64;

function normalizedDenyUrl(url: string): string {
	try {
		const u = new URL(url);
		return u.origin + u.pathname;
	} catch {
		return url;
	}
}

/** Cache key for a (view, URL) deny — exported so the egress worker can track
 *  which of ITS denies are cached here and post targeted clears on re-allow. */
export function denyKey(url: string, viewId?: string): string {
	return JSON.stringify([viewId || null, normalizedDenyUrl(url)]);
}

/** Record a deny for the recent-deny cache. Main thread only — the egress
 *  worker posts its denies to the host, which applies them here (the cache and
 *  the audit trail stay single-writer). */
export function recordEgressDeny(url: string, viewId: string | undefined, reason: string, recovery?: string): void {
	const key = denyKey(url, viewId);
	if (!recentDenies.has(key) && recentDenies.size >= DENY_MAX) {
		const oldest = recentDenies.keys().next().value;
		if (oldest !== undefined) recentDenies.delete(oldest);
	}
	recentDenies.set(key, { reason, recovery, at: Date.now() });
}

/** Consume the recorded policy deny for this exact view and URL, if recent. */
export function recentEgressDeny(url: string, viewId?: string): { reason: string; recovery?: string } | null {
	const key = denyKey(url, viewId);
	const hit = recentDenies.get(key);
	if (!hit) return null;
	recentDenies.delete(key);
	if (Date.now() - hit.at > DENY_TTL_MS) {
		return null;
	}
	return { reason: hit.reason, recovery: hit.recovery };
}

/** NON-consuming twin of recentEgressDeny — read the recorded deny without
 *  removing it, so a UI surface can show the reason while the navigate error
 *  path still gets its one consume. */
export function peekEgressDeny(url: string, viewId?: string): { reason: string; recovery?: string } | null {
	const hit = recentDenies.get(denyKey(url, viewId));
	if (!hit || Date.now() - hit.at > DENY_TTL_MS) return null;
	return { reason: hit.reason, recovery: hit.recovery };
}

/** Drop a recorded deny (worker re-allow for the same view+URL — mirrors the
 *  in-loop path's clear-on-allow so a stale reason never outlives a retry). */
export function clearEgressDeny(url: string, viewId?: string): void {
	recentDenies.delete(denyKey(url, viewId));
}

/** Rewrap a navigate/newTab failure whose Chromium symptom
 *  (ERR_BLOCKED_BY_CLIENT) was caused by a recorded egress-policy deny, so the
 *  agent sees the policy's reason and recovery path instead of the bare
 *  network-stack error. Any other failure passes through untouched. */
export function enrichBlockedNavigation(e: unknown, url: string, viewId?: string): unknown {
	const message = e instanceof Error ? e.message : String(e);
	if (!message.includes("ERR_BLOCKED_BY_CLIENT")) return e;
	const deny = recentEgressDeny(url, viewId);
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

/** The pluggable inputs decideEgressAsk evaluates against. The in-loop path
 *  binds the canonical module-backed implementations below; the egress worker
 *  thread binds its config cache + mirrored registries. ONE decision core. */
export interface EgressAskDeps {
	/** Canonical URL/SSRF policy — fail-closed. */
	evaluateUrl(url: string): SecurityDecision;
	/** viewId → owning session (agent viewId parse, or adopted-tab registry). */
	sessionForView(viewId: string): string | undefined;
	/** Taint-aware page-egress scan (page-egress-taint.ts semantics). */
	scan(sessionId: string, req: PageEgressRequest): PageEgressVerdict;
}

/** decideEgressAsk result. Side effects (deny cache, canary audit) are the
 *  CALLER's to apply — on the main thread directly, from the worker via posts
 *  to the host — so the single-writer registries stay on one thread. */
export interface EgressAskOutcome {
	allowed: boolean;
	/** Deny detail for the recent-deny cache; absent on allow or evaluation error. */
	deny?: { reason: string; recovery?: string };
	/** Set when a canary tripped — the caller owes the one-time exfil audit. */
	canarySessionId?: string;
}

/**
 * Decide one egress ask: (1) the canonical URL/SSRF policy — fail-closed,
 * including on an evaluation error; then (2) the taint-aware page-egress scan
 * for session-attributable views — defense-in-depth that FAILS OPEN on a scan
 * error (the URL policy already passed fail-closed, and a bug in the payload
 * scan must not brick all in-app browsing — the reverted same-site CSP's exact
 * failure mode). Pure w.r.t. the deny/audit registries; logging only.
 */
export function decideEgressAsk(ask: EgressAskMessage, deps: EgressAskDeps): EgressAskOutcome {
	try {
		const decision = deps.evaluateUrl(ask.url);
		// A silent deny here renders in the browser as ERR_BLOCKED_BY_CLIENT with
		// ZERO server-side trace — undiagnosable (2026-07-20). Name the reason.
		if (decision.allowed !== true) {
			logger.warn(`[browser-bridge] egress DENY ${ask.url.slice(0, 120)}: ${decision.reason ?? "policy"}`);
			return {
				allowed: false,
				deny: { reason: decision.reason ?? "blocked by the egress policy", recovery: decision.recovery ?? decision.userHint },
			};
		}
		const sessionId = typeof ask.viewId === "string" && ask.viewId ? deps.sessionForView(ask.viewId) : undefined;
		if (!sessionId) return { allowed: true }; // unattributable view → URL policy only.
		try {
			const verdict = deps.scan(sessionId, { url: ask.url, pageUrl: ask.pageUrl, body: ask.body });
			if (verdict.allowed) return { allowed: true };
			logger.warn(`[browser-bridge] page egress BLOCKED [${verdict.layer}] session=${sessionId}: ${verdict.reason}`);
			return {
				allowed: false,
				deny: { reason: verdict.reason ?? "blocked by the page-egress taint scan" },
				// Canary is definitive exfil: the enforcing caller records the
				// tamper-evident audit exactly once (the scan itself is pure).
				...(verdict.canary ? { canarySessionId: sessionId } : {}),
			};
		} catch (e) {
			logger.warn(`[browser-bridge] page-egress taint scan errored (allowing — URL policy already passed): ${(e as Error).message}`);
			return { allowed: true };
		}
	} catch (e) {
		logger.warn(`[browser-bridge] egress evaluation failed for ${ask.url}: ${(e as Error).message}`);
		return { allowed: false };
	}
}

/** The canonical module-backed deps: live config reads + the in-process
 *  session registries. The worker builds its own equivalent (cached config,
 *  mirrored registries) in egress-worker.ts. */
function inLoopEgressDeps(): EgressAskDeps {
	const selfPort = process.env.LAX_PORT ?? String(getRuntimeConfig().port);
	return {
		evaluateUrl: (url) => evaluateEgressForUrl(url, selfPort),
		sessionForView: (viewId) => sessionIdFromViewId(viewId) ?? adoptedViewSession(viewId),
		scan: scanPageEgress,
	};
}

/** Answer the desktop egress guard from the canonical URL policy PLUS the
 *  taint-aware page-egress scan. The URL policy is fail-closed on both ends; the
 *  taint scan is defense-in-depth layered on top of an allow. This is the
 *  IN-LOOP fallback path — the egress worker answers the same asks off-loop
 *  over its pipe using the same decideEgressAsk core. */
export function answerEgressAsk(ask: EgressAskMessage): void {
	let allowed = false;
	try {
		const outcome = decideEgressAsk(ask, inLoopEgressDeps());
		allowed = outcome.allowed;
		if (outcome.deny) recordEgressDeny(ask.url, ask.viewId, outcome.deny.reason, outcome.deny.recovery);
		if (outcome.canarySessionId) recordCanaryExfilAudit(outcome.canarySessionId, "browser-page-egress");
		if (allowed) recentDenies.delete(denyKey(ask.url, ask.viewId));
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
